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

// --------------------
// Webhook MUST BE RAW
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

  if (event.type === "payment_intent.succeeded") {
    const intent = event.data.object;
    log("✔ Payment succeeded:", intent.id);

    const payload = {
      payment_intent_id: intent.id,
      customer_id: intent.metadata?.customer_id ?? null,
      cart_id: intent.metadata?.cart_id ?? null,
      shipping_fee: intent.metadata?.shipping_fee ?? null,
      amountPHP: (intent.amount || 0) / 100,
      receipt_url: intent.charges?.data?.[0]?.receipt_url || null,
      status: "paid"
    };

    // ------------------------------
    // SEND TO INFINITYFREE (correct)
    // ------------------------------
    try {
      const response = await fetch(
        "https://revaux.infinityfree.me/hooks/stripe_confirm.php?i=1",
        {
          method: "POST",
          redirect: "follow",   // <-- THIS MAKES IT FOLLOW THE JS REDIRECT
          headers: {
            "Content-Type": "application/json",
            "X-API-KEY": (process.env.INF_API_KEY || "").trim()
          },
          body: JSON.stringify(payload)
        }
      );


      const txt = await response.text();
      console.log("InfinityFree says:", txt);
    } catch (err) {
      console.error("❌ Failed to notify InfinityFree:", err.message);
    }

    res.json({ received: true });
    return;
  }

  res.json({ received: true });
});

// --------------------
// Normal routes
// --------------------
app.use(cors());
app.use(express.json());

app.post("/create-payment", async (req, res) => {
  try {
    const { amountPHP, customer_id, cart_id, shipping_fee } = req.body;
    if (!amountPHP) return res.status(400).json({ error: "amountPHP required" });

    const pi = await stripe.paymentIntents.create({
      amount: Math.round(amountPHP * 100),
      currency: "php",
      metadata: {
        customer_id: customer_id ?? "",
        cart_id: cart_id ?? "",
        shipping_fee: shipping_fee ?? ""
      }
    });

    res.json({ clientSecret: pi.client_secret, paymentIntentId: pi.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/verify-payment", async (req, res) => {
  try {
    const { paymentIntentId } = req.body;
    if (!paymentIntentId) 
      return res.status(400).json({ error: "paymentIntentId required" });

    const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ["latest_charge.payment_method_details"]
    });

    const receipt = pi.latest_charge?.receipt_url || null;
    const brand = pi.latest_charge?.payment_method_details?.card?.brand || "unknown";

    res.json({
      status: pi.status,
      amountPHP: (pi.amount || 0) / 100,
      currency: pi.currency,
      receipt_url: receipt,
      payment_method: brand
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


app.get("/", (req, res) =>
  res.json({ status: "ok", message: "Stripe backend running" })
);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));




