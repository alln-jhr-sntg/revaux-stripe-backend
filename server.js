// server.js
import express from "express";
import Stripe from "stripe";
import cors from "cors";
import bodyParser from "body-parser";
import fetch from "node-fetch"; // optional if your Node runtime lacks global fetch

const app = express();

// Allowed origins - restrict in production
const allowedOrigins = [process.env.FRONTEND_ORIGIN || "https://your-infinityfree-domain.example"];
app.use(cors({
  origin: (origin, cb) => {
    // allow Postman / server-to-server (no origin)
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error("CORS not allowed"), false);
  }
}));

app.use(express.json()); // parse JSON for /create-payment, etc.

const stripe = new Stripe(process.env.STRIPE_SECRET, { apiVersion: null });

// Convert PHP to USD
async function convertPHPtoUSD(amountPHP) {
  const res = await fetch("https://api.exchangerate.host/latest?base=PHP&symbols=USD");
  if (!res.ok) throw new Error("Exchange rate fetch failed");
  const data = await res.json();
  if (!data.rates || !data.rates.USD) throw new Error("USD rate missing");
  return amountPHP * data.rates.USD;
}

/**
 * POST /create-payment
 * Body: { amountPHP, customer_id?, cart_id?, shipping_fee?, shipping_address? }
 * Returns: { clientSecret, order_id? }
 */
app.post("/create-payment", async (req, res) => {
  try {
    const { amountPHP, customer_id, cart_id, shipping_fee, shipping_address } = req.body;
    if (!amountPHP) return res.status(400).json({ error: "amountPHP required" });

    // Convert to USD and cents
    const usd = await convertPHPtoUSD(Number(amountPHP));
    const amountUSDcents = Math.round(usd * 100);

    // Create PaymentIntent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountUSDcents,
      currency: "usd",
      // optional: attach metadata so you can link intent -> order easily
      metadata: {
        customer_id: customer_id ? String(customer_id) : "",
        cart_id: cart_id ? String(cart_id) : ""
      }
    });

    // OPTIONAL: create draft order on your InfinityFree site
    // If you have an endpoint like https://your-site/create-draft-order.php that accepts JSON and returns order_id:
    let order_id = null;
    if (process.env.CREATE_DRAFT_URL) {
      try {
        const draftRes = await fetch(process.env.CREATE_DRAFT_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-KEY": process.env.CREATE_DRAFT_API_KEY || ""
          },
          body: JSON.stringify({
            customer_id, cart_id, total_php: amountPHP, shipping_fee, shipping_address,
            stripe_payment_intent: paymentIntent.id
          })
        });
        if (draftRes.ok) {
          const json = await draftRes.json();
          order_id = json.order_id || json.id || null;
        } else {
          console.warn("Draft order creation failed:", draftRes.status);
        }
      } catch (err) {
        console.warn("Draft order request error:", err.message);
      }
    }

    return res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      order_id
    });
  } catch (err) {
    console.error("create-payment error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Webhook endpoint — must receive raw body
 * Configure Stripe webhook to call: https://<your-render-url>/webhook
 */
app.post("/webhook", bodyParser.raw({ type: "application/json" }), (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle events
  switch (event.type) {
    case "payment_intent.succeeded": {
      const intent = event.data.object;
      console.log("PaymentIntent succeeded:", intent.id);

      // OPTIONAL: notify your InfinityFree server to mark order as paid
      if (process.env.CONFIRM_ORDER_URL && intent.metadata) {
        const payload = {
          payment_intent: intent.id,
          payment_status: intent.status,
          metadata: intent.metadata
        };
        fetch(process.env.CONFIRM_ORDER_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-KEY": process.env.CONFIRM_ORDER_API_KEY || ""
          },
          body: JSON.stringify(payload)
        }).then(r => {
          if (!r.ok) console.warn("confirm-order call failed", r.status);
        }).catch(e => console.warn("confirm-order fetch error", e.message));
      }
      break;
    }
    case "payment_intent.payment_failed": {
      const intent = event.data.object;
      console.log("Payment failed:", intent.id);
      // handle failure (notify user, mark order pending/failed)
      break;
    }
    default:
      console.log(`Unhandled event type ${event.type}`);
  }

  res.json({ received: true });
});

// Listen on Render's assigned port
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

