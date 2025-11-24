import express from "express";
import Stripe from "stripe";
import cors from "cors";
import bodyParser from "body-parser";

const app = express();
app.use(cors());
app.use(express.json()); // JSON parsing for normal routes

const stripe = new Stripe(process.env.STRIPE_SECRET);

// Convert PHP → USD
async function convertPHPtoUSD(amountPHP) {
  const res = await fetch(
    "https://api.exchangerate.host/latest?base=PHP&symbols=USD"
  );
  const data = await res.json();
  return amountPHP * data.rates.USD;
}

// ---- Create PaymentIntent (PHP currency) ----
app.post("/create-payment", async (req, res) => {
  try {
    const { amountPHP, customer_id, cart_id, shipping_fee } = req.body;

    if (!amountPHP) {
      return res.status(400).json({ error: "amountPHP is required" });
    }

    // Convert PHP → centavos
    const amountInCentavos = Math.round(amountPHP * 100);

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCentavos,
      currency: "php",   // ✔ native PHP currency
      metadata: {
        customer_id,
        cart_id,
        shipping_fee,
      },
    });

    return res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
    });

  } catch (err) {
    console.error("Payment error:", err);
    return res.status(500).json({ error: err.message });
  }
});


// ---- Stripe Webhook (Raw Body Required) ----
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Webhook signature error:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle successful payment
    if (event.type === "payment_intent.succeeded") {
      const intent = event.data.object;

      console.log("✔ Payment succeeded:", intent.id);

      // Extract metadata
      const customer_id = intent.metadata.customer_id;
      const cart_id = intent.metadata.cart_id;
      const shipping_fee = intent.metadata.shipping_fee;
      const amountPHP = intent.amount / 100; // Stripe stores in centavos

      // Prepare payload to InfinityFree
      const payload = {
        payment_intent_id: intent.id,
        customer_id,
        cart_id,
        shipping_fee,
        amountPHP,
        status: "paid"
      };

      try {
        // Call your InfinityFree endpoint to update orders
        await fetch("https://YOUR-INFINITYFREE-DOMAIN.com/api/confirm_order.php", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-KEY": process.env.INF_API_KEY },
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


// ---- Verify PaymentIntent (called by payment_success.php) ----
app.post("/verify-payment", express.json(), async (req, res) => {
  try {
    const { paymentIntentId } = req.body;

    if (!paymentIntentId) {
      return res.status(400).json({ error: "paymentIntentId is required" });
    }

    // Retrieve PaymentIntent from Stripe
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);

    // Extract important fields
    const status = pi.status;
    const amount = pi.amount;              // in centavos
    const currency = pi.currency;
    const receiptUrl =
      pi.charges?.data?.[0]?.receipt_url || null;
    const paymentMethod =
      pi.charges?.data?.[0]?.payment_method_details?.card?.brand || "unknown";

    // Convert amount to PHP pesos
    const amountPHP = amount / 100;

    return res.json({
      status,
      amountPHP,
      currency,
      receipt_url: receiptUrl,
      payment_method: paymentMethod
    });

  } catch (err) {
    console.error("Verify error:", err);
    return res.status(500).json({ error: err.message });
  }
});

app.listen(10000, () => console.log("Server running on port 10000"));



