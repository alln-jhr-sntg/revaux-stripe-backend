// server.js
import express from "express";
import Stripe from "stripe";
import cors from "cors";
import bodyParser from "body-parser";
import fetch from "node-fetch"; // npm i node-fetch@2
import mysql from "mysql2/promise";
import fs from "fs";
import path from "path";
import nodemailer from "nodemailer";

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET);

// --------------------
// Utility helpers
// --------------------
function log(...args) {
  console.log(...args);
}

async function saveFallbackOrder(payload) {
  // store to a local file on Render (persisted between deploys until cleaned)
  const file = path.resolve("./pending_orders.json");
  let arr = [];
  try {
    if (fs.existsSync(file)) {
      arr = JSON.parse(fs.readFileSync(file, "utf8") || "[]");
    }
  } catch (e) {
    console.warn("Could not read fallback file:", e.message);
    arr = [];
  }
  arr.push({ received_at: new Date().toISOString(), payload });
  fs.writeFileSync(file, JSON.stringify(arr, null, 2));
  return file;
}

async function sendAdminEmail(subject, text) {
  // Only works if SMTP env vars are configured
  const smtpHost = process.env.SMTP_HOST;
  if (!smtpHost) {
    log("SMTP not configured, skipping email.");
    return;
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: (process.env.SMTP_SECURE === "true"), // true for 465, false for other ports
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: process.env.ADMIN_EMAIL,
    subject,
    text
  });
  log("Admin email sent.");
}

// --------------------
// Webhook MUST be raw
// --------------------
app.post("/webhook", bodyParser.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    log("Webhook signature error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle events
  if (event.type === "payment_intent.succeeded") {
    const intent = event.data.object;
    log("✔ Payment succeeded:", intent.id);

    // Extract metadata your frontend attached earlier
    const customer_id = intent.metadata?.customer_id ?? null;
    const cart_id = intent.metadata?.cart_id ?? null;
    const shipping_fee = intent.metadata?.shipping_fee ?? null;
    const amountPHP = (intent.amount || 0) / 100;
    const receiptUrl = intent.charges?.data?.[0]?.receipt_url || null;

    // Payload for DB
    const payload = {
      payment_intent_id: intent.id,
      customer_id,
      cart_id,
      shipping_fee,
      amountPHP,
      receipt_url: receiptUrl,
      status: "paid"
    };

    try {
      const response = await fetch(
        "https://revaux-stripe-backend.onrender.com/confirm-order",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        }
      );
    
      const txt = await response.text();
      console.log("Render confirm-order says:", txt);
    } catch (err) {
      console.error("❌ Failed to notify /confirm-order:", err.message);
    }


    // Attempt direct DB write if DB env provided
    const DB_HOST = process.env.DB_HOST;
    if (DB_HOST && process.env.DB_NAME && process.env.DB_USER) {
      try {
        log("Attempting to connect to DB:", DB_HOST);
        const conn = await mysql.createConnection({
          host: DB_HOST,
          user: process.env.DB_USER,
          password: process.env.DB_PASS,
          database: process.env.DB_NAME,
          port: Number(process.env.DB_PORT || 3306),
          connectTimeout: 10000
        });

        // Make this query match your schema; adjust column names if different.
        const sql = `
          INSERT INTO orders (customer_id, cart_id, total, shipping_fee, payment_method, payment_status, stripe_payment_intent, stripe_receipt_url)
          VALUES (?, ?, ?, ?, 'Credit Card', 'Paid', ?, ?)
          ON DUPLICATE KEY UPDATE
            payment_status = VALUES(payment_status),
            stripe_payment_intent = VALUES(stripe_payment_intent),
            stripe_receipt_url = VALUES(stripe_receipt_url)
        `;
        const params = [
          payload.customer_id,
          payload.cart_id,
          payload.amountPHP,
          payload.shipping_fee,
          payload.payment_intent_id,
          payload.receipt_url
        ];
        const [result] = await conn.execute(sql, params);
        log("DB write result:", result);
        await conn.end();

        // respond 200 to Stripe
        res.json({ received: true });
        return;
      } catch (err) {
        log("DB write failed:", err.message);
        // fall through to fallback behavior
      }
    } else {
      log("DB env not configured — skipping direct DB write.");
    }

    // Fallback: save locally and notify admin by email (if configured)
    try {
      const file = await saveFallbackOrder(payload);
      log("Saved fallback order to:", file);
      if (process.env.ADMIN_EMAIL) {
        await sendAdminEmail("Stripe order received (fallback)", `Order saved to ${file}\n\nPayload:\n${JSON.stringify(payload, null, 2)}`);
      }
      res.json({ received: true, fallback_saved: file });
      return;
    } catch (err) {
      log("Fallback save failed:", err.message);
      return res.status(500).send("Failed to persist order");
    }
  }

  // Acknowledge other events for now
  res.json({ received: true });
});

// -------------------------------
// CONFIRM ORDER ON RENDER (replaces stripe_confirm.php)
// -------------------------------
app.post("/confirm-order", async (req, res) => {
  const {
    payment_intent_id,
    customer_id,
    cart_id,
    shipping_fee,
    amountPHP,
    receipt_url
  } = req.body;

  if (!payment_intent_id || !customer_id || !cart_id) {
    return res.status(400).json({ error: "Missing fields" });
  }

  try {
    console.log("✔ Writing order to DB...");

    const conn = await mysql.createConnection({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
      port: Number(process.env.DB_PORT || 3306),
      connectTimeout: 10000
    });

    const sql = `
      INSERT INTO orders 
      (customer_id, cart_id, total, shipping_fee, payment_method, payment_status, stripe_payment_intent, stripe_receipt_url)
      VALUES (?, ?, ?, ?, 'Credit Card', 'Paid', ?, ?)
      ON DUPLICATE KEY UPDATE
        payment_status = VALUES(payment_status),
        stripe_payment_intent = VALUES(stripe_payment_intent),
        stripe_receipt_url = VALUES(stripe_receipt_url)
    `;

    const params = [
      customer_id,
      cart_id,
      amountPHP,
      shipping_fee,
      payment_intent_id,
      receipt_url || null
    ];

    const [result] = await conn.execute(sql, params);
    await conn.end();

    console.log("✔ DB update complete:", result);
    return res.json({ status: "ok", db: result });

  } catch (err) {
    console.error("❌ DB write error:", err);
    return res.status(500).json({ error: "DB update failed", details: err.message });
  }
});


// --------------------
// Normal JSON routes
// --------------------
app.use(cors());
app.use(express.json());

// Create PaymentIntent (frontend calls this)
app.post("/create-payment", async (req, res) => {
  try {
    const { amountPHP, customer_id, cart_id, shipping_fee } = req.body;
    if (!amountPHP) return res.status(400).json({ error: "amountPHP required" });

    const amtCents = Math.round(amountPHP * 100);
    const pi = await stripe.paymentIntents.create({
      amount: amtCents,
      currency: "php",
      metadata: { customer_id: customer_id ?? "", cart_id: cart_id ?? "", shipping_fee: shipping_fee ?? "" }
    });

    res.json({ clientSecret: pi.client_secret, paymentIntentId: pi.id });
  } catch (err) {
    log("create-payment error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Verify endpoint used by payment_success.php
app.post("/verify-payment", async (req, res) => {
  try {
    const { paymentIntentId } = req.body;
    if (!paymentIntentId) return res.status(400).json({ error: "paymentIntentId required" });

    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    const receiptUrl = pi.charges?.data?.[0]?.receipt_url || null;
    res.json({
      status: pi.status,
      amountPHP: (pi.amount || 0) / 100,
      currency: pi.currency,
      receipt_url: receiptUrl,
      payment_method: pi.charges?.data?.[0]?.payment_method_details?.card?.brand || "unknown"
    });
  } catch (err) {
    log("verify-payment error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// health check
app.get("/", (req, res) => res.json({ status: "ok", message: "Stripe backend running" }));

// start
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => log(`Server running on port ${PORT}`));




