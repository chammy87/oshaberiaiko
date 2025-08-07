import express from "express";
import dotenv from "dotenv";
import Stripe from "stripe";

dotenv.config();

const stripe = new Stripe("sk_test_あなたのStripe秘密キー", {
  apiVersion: "2023-10-16", // 最新バージョンに合わせる
});

const app = express();
const PORT = process.env.PORT || 10000;

// Stripe webhook用エンドポイント（必ずrawで受け取る）
app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const sig = req.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    console.log("✅ Webhook受信成功:", event.type);
    res.json({ received: true });
  } catch (err) {
    console.error("❌ Webhook signature verification failed:", err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

app.get("/", (req, res) => {
  res.send("Webhook server is live");
});

app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});
