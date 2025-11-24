import express from "express";
import Stripe from "stripe";
import cors from "cors";
import bodyParser from "body-parser";

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET);

// ---------------------------------------------------------
// 1️⃣ HANDLE WEBHOOK FIRST! NO express.json() BEFORE THIS
// ---------------------------------------------------------
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body, // MUST be raw Buffer
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Webhook signature error:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Stripe event: payment succeeded
    if (event.type === "payment_intent.succeeded") {
      const intent = event.data.object;

      console.log("✔ Payment succeeded:", intent.id);

      // extract metadata
      const customer_id = intent.metadata.customer_id;
      const cart_id = intent.metadata.cart_id;
      const shipping_fee = intent.metadata.shipping_fee;
      const amountPHP = intent.amount / 100;

      const payload = {
        payment_intent_id: intent.id,
        customer_id,
        cart_id,
        shipping_fee,
        amountPHP,
        status: "paid"
      };

      try {
        await fetch("http://revaux.infinityfree.me/hooks/stripe_confirm.php", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0",
            "X-API-KEY": process.env.INF_API_KEY
          },
          body: JSON.stringify(payload)
        });

        console.log("✔ Order updated on InfinityFree.");
      } catch (err) {
        console.error("❌ Failed to notify InfinityFree:", err.message);
      }
    }

    res.json({ received: true });
  }
);

// ---------------------------------------------------------
// 2️⃣ NORMAL MIDDLEWARE (safe AFTER webhook)
// ---------------------------------------------------------
app.use(cors());
app.use(express.json()); // OK for normal endpoints now

// ---------------------------------------------------------
// 3️⃣ CREATE PAYMENTINTENT (normal JSON route)
// ---------------------------------------------------------
app.post("/create-payment", async (req, res) => {
  try {
    const { amountPHP, customer_id, cart_id, shipping_fee } = req.body;

    if (!amountPHP) {
      return res.status(400).json({ error: "amountPHP is required" });
    }

    const amountInCentavos = Math.round(amountPHP * 100);

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCentavos,
      currency: "php",
      metadata: { customer_id, cart_id, shipping_fee }
    });

    return res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id
    });

  } catch (err) {
    console.error("Payment error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------
// 4️⃣ VERIFY PAYMENT
// ---------------------------------------------------------
app.post("/verify-payment", async (req, res) => {
  try {
    const { paymentIntentId } = req.body;

    if (!paymentIntentId) {
      return res.status(400).json({ error: "paymentIntentId is required" });
    }

    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);

    const status = pi.status;
    const amount = pi.amount;
    const receiptUrl = pi.charges?.data?.[0]?.receipt_url || null;
    const paymentMethod =
      pi.charges?.data?.[0]?.payment_method_details?.card?.brand || "unknown";

    return res.json({
      status,
      amountPHP: amount / 100,
      currency: pi.currency,
      receipt_url: receiptUrl,
      payment_method: paymentMethod
    });

  } catch (err) {
    console.error("Verify error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------
// 5️⃣ Optional health check
// ---------------------------------------------------------
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Stripe backend running" });
});

app.listen(10000, () => console.log("Server running on port 10000"));


