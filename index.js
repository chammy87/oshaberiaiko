import express from "express";
import Stripe from "stripe";
import dotenv from "dotenv";
dotenv.config();

// === Firestore ===
import admin from "firebase-admin";
const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, "base64").toString("utf8")
);
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

const app = express();
const port = process.env.PORT || 10000;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

// --- Stripe Webhook（rawで受信・最上部に置く）---
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  // Stripe以外（署名ヘッダのないアクセス）は静かに無視
  if (!sig) {
    console.log("🤷 署名なしの非Stripeアクセスを無視（/webhook）");
    return res.status(200).end();
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
    console.log("✅ Webhook受信:", event.type);
  } catch (err) {
    console.error("❌ 署名検証エラー:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ① 重複実行防止（idempotency）
  const seenRef = db.collection("stripe_events").doc(event.id);
  const seen = await seenRef.get();
  if (seen.exists) {
    console.log("↩️ 既に処理済み:", event.id);
    return res.json({ received: true });
  }

  try {
    // ② イベントごとの処理
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const userId = session.metadata?.userId;
        if (userId) {
          // 初回サイクルの次回更新日時を取得
          let premiumUntilTs = null;
          try {
            if (session.mode === "subscription" && session.subscription) {
              const sub =
                typeof session.subscription === "string"
                  ? await stripe.subscriptions.retrieve(session.subscription)
                  : session.subscription; // まれにオブジェクトで来る場合に対応
              if (sub?.current_period_end) {
                premiumUntilTs = admin.firestore.Timestamp.fromDate(
                  new Date(sub.current_period_end * 1000)
                );
              }
            }
          } catch (e) {
            console.warn("⚠️ subscription取得に失敗:", e.message);
          }

          await db.collection("users").doc(userId).set(
            {
              premium: true,
              premiumSince: admin.firestore.FieldValue.serverTimestamp(),
              ...(premiumUntilTs ? { premiumUntil: premiumUntilTs } : {})
            },
            { merge: true }
          );
          console.log(`🎉 Premium付与: ${userId} (session ${session.id})`);
        } else {
          console.log("ℹ️ userIdがmetadataにありません");
        }
        break;
      }

      case "invoice.payment_succeeded": {
        const inv = event.data.object; // Stripe.Invoice
        const userId =
          inv.metadata?.userId ||
          inv.subscription_details?.metadata?.userId ||
          (inv.lines?.data?.[0]?.metadata?.userId) ||
          undefined;

        // 次回更新日の候補（lines[0].period.end が最優先）
        const periodEndSec = inv.lines?.data?.[0]?.period?.end || inv.period_end;
        if (userId && periodEndSec) {
          const premiumUntilTs = admin.firestore.Timestamp.fromDate(new Date(periodEndSec * 1000));
          await db.collection("users").doc(userId).set(
            { premium: true, premiumUntil: premiumUntilTs },
            { merge: true }
          );
        }
        console.log(
          `✅ 継続課金成功: invoice ${inv.id}, amount=${inv.amount_paid}, userId=${userId || "N/A"}, next=${periodEndSec || "N/A"}`
        );
        break;
      }

      case "payment_intent.succeeded": {
        const pi = event.data.object;
        console.log(`💰 PaymentIntent成功: ${pi.id}, amount=${pi.amount}`);
        break;
      }

      case "payment_intent.payment_failed": {
        const pi = event.data.object;
        const reason = pi.last_payment_error?.message || "unknown";
        console.log(`❌ PaymentIntent失敗: ${pi.id}, reason=${reason}`);
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object;
        console.log(`❌ 請求失敗: invoice ${invoice.id}, customer=${invoice.customer}`);
        break;
      }

      case "checkout.session.expired": {
        const s = event.data.object;
        console.log(`⌛ Checkout期限切れ: ${s.id}`);
        break;
      }

      // ★ 解約（サブスク終了）→ premium を落とす＋期限クリア
      case "customer.subscription.deleted": {
        const sub = event.data.object; // Stripe.Subscription
        const userId = sub.metadata?.userId;
        console.log(`👋 退会: subscription ${sub.id}, userId=${userId || "N/A"}`);
        if (userId) {
          await db.collection("users").doc(userId).set(
            { premium: false, premiumUntil: null },
            { merge: true }
          );
        }
        break;
      }

      default: {
        console.log(`ℹ️ 未処理イベント: ${event.type}`);
        break;
      }
    }

    // ③ 処理済みマーク
    await seenRef.set({ processedAt: admin.firestore.FieldValue.serverTimestamp() });
    return res.json({ received: true });

  } catch (err) {
    console.error("🛑 ハンドラ処理中エラー:", err);
    // 5xxを返すとStripeが自動リトライ
    return res.status(500).end();
  }
});

// 他のルートは raw の後で
app.use(express.json());
app.use(express.static("public"));

// APIルート（任意）
app.get("/api/hello", (req, res) => {
  res.json({ message: "Hello from API" });
});

app.get("/api/user/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const snap = await db.collection("users").doc(id).get();
    if (!snap.exists) {
      return res.status(404).json({ exists: false });
    }
    const data = snap.data();

    // Firestore Timestamp -> ISO文字列（null安全）
    const toISO = (v) =>
      v && typeof v.toDate === "function" ? v.toDate().toISOString() : v || null;

    res.json({
      exists: true,
      premium: !!data.premium,
      premiumSince: toISO(data.premiumSince),
      premiumUntil: toISO(data.premiumUntil),
    });
  } catch (e) {
    console.error("Get user error:", e);
    res.status(500).json({ error: "internal_error" });
  }
});

// チェックアウト・セッション（テスト用）
app.post("/create-checkout-session", async (req, res) => {
  try {
    const userId = req.body.userId || "demo-user";
    const session = await stripe.checkout.sessions.create({
      mode: "subscription", // 単発なら "payment"
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: "https://www.oshaberiaiko.com/success",
      cancel_url: "https://www.oshaberiaiko.com/cancel",
      // セッションにも、作成される subscription にも userId を残す
      metadata: { userId },
      subscription_data: { metadata: { userId } },
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error("Session error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.listen(port, () => console.log(`Server on :${port}`));
