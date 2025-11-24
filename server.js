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

// ---- Create PaymentIntent ----
app.post("/create-payment", async (req, res) => {
  try {
    const { amountPHP } = req.body;

    const usd = await convertPHPtoUSD(amountPHP);
    const amountUSD = Math.round(usd * 100);

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountUSD,
      currency: "usd",
      metadata: {
        // Add anything you need here
        amountPHP,
      },
    });

    return res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ---- Stripe Webhook (raw body ONLY) ----
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  (req, res) => {
    const sig = req.headers["stripe-signature"];

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error(err);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "payment_intent.succeeded") {
      const intent = event.data.object;
      console.log("Payment successful:", intent.id);
    }

    res.json({ received: true });
  }
);

app.listen(10000, () => console.log("Server running on port 10000"));
