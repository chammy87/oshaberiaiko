import express from "express";
import Stripe from "stripe";
import dotenv from "dotenv";
dotenv.config();

const app = express();
const port = process.env.PORT || 10000;

// ✅ Stripe クライアント（テストキーでOK）
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

// ✅ webhook だけは raw で受ける
app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const sig = req.headers["stripe-signature"];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
    console.log("✅ Webhook受信:", event.type);
  } catch (err) {
    console.error("❌ 署名検証エラー:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // --- 最小の本処理 ---
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const userId = session.metadata?.userId || "unknown";
    // ここでDB更新など（今はログだけ）
    console.log(`🎉 Premium付与（ダミー）: userId=${userId}, session=${session.id}`);
  }

  res.json({ received: true });
});

// ✅ それ以外のAPIは JSON でOK（順番に注意！）
app.use(express.json());

// チェックアウトセッション作成（テスト）
app.post("/create-checkout-session", async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",                    // 一回払いなら "payment"
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: "https://example.com/success",
      cancel_url: "https://example.com/cancel",
      metadata: { userId: req.body.userId || "demo-user" },
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error("Session error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/", (_, res) => res.send("OK"));

app.listen(port, () => console.log(`Server on :${port}`));
