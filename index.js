import express from "express";
import Stripe from "stripe";
import dotenv from "dotenv";
import OpenAI from "openai";
import { system as aikoSystem } from "./Prompt.js";

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

/* -------------------- OpenAI クライアント -------------------- */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 危険ワード検知（簡易）
const isHighRisk = (t = "") => {
  const s = (t || "").toLowerCase();
  return ["死にたい", "消えたい", "自殺", "傷つける", "虐待", "子どもが危険", "飛び降り", "首を", "窒息"]
    .some(k => s.includes(k.toLowerCase()));
};
const safetyFallbackJP = () =>
  "いま本当にしんどいよね。まずはあなたの安全がいちばん大事だよ。もし切迫していたら、近くの人に助けを求めつつ119（救急）や110（警察）に連絡してね。落ち着けるなら、地域の保健所や自治体のこころの相談、医療機関、信頼できる人に繋がるのもひとつの選択肢だよ。";

// 簡易認証
function checkAuth(req) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  const need = process.env.AIKO_API_TOKEN;
  return !need || token === need;
}

/* -------------------- 会話API -------------------- */
app.post("/api/aiko-reply", express.json(), async (req, res) => {
  try {
    if (!checkAuth(req)) return res.status(401).json({ error: "unauthorized" });

    const userText = String(req.body?.text || "").trim();
    if (!userText) return res.status(400).json({ error: "missing text" });

    if (isHighRisk(userText)) {
      return res.json({ reply: safetyFallbackJP(), mode: "safety" });
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: aikoSystem },
        { role: "user", content: userText },
      ],
      temperature: 0.7,
    });

    const reply =
      completion.choices?.[0]?.message?.content?.trim() ||
      "うんうん、聞いてるよ。";

    res.json({ reply, mode: "normal" });
  } catch (e) {
    console.error("aiko-reply error:", e);
    res.status(500).json({ error: "internal_error" });
  }
});

/* -------------------- 小ヘルパー -------------------- */
const tsFromSec = (sec) =>
  sec ? admin.firestore.Timestamp.fromDate(new Date(sec * 1000)) : null;

async function resolveUserIdFromCustomerId(customerId) {
  if (!customerId) return null;
  const snap = await db
    .collection("users")
    .where("stripeCustomerId", "==", customerId)
    .limit(1)
    .get();
  return snap.empty ? null : snap.docs[0].id;
}

async function resolveUserIdFromSub(sub) {
  if (!sub) return null;
  if (sub.metadata?.userId) return sub.metadata.userId;
  const customerId =
    typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
  return await resolveUserIdFromCustomerId(customerId);
}

async function resolveUserIdFromInvoice(inv) {
  if (!inv) return null;
  if (inv.metadata?.userId) return inv.metadata.userId;

  let sub = inv.subscription;
  if (typeof sub === "string") {
    try {
      sub = await stripe.subscriptions.retrieve(sub);
    } catch (_) {
      sub = null;
    }
  }
  if (sub?.metadata?.userId) return sub.metadata.userId;

  const customerId =
    typeof inv.customer === "string" ? inv.customer : inv.customer?.id;
  return await resolveUserIdFromCustomerId(customerId);
}

/* -------------------- Webhook (raw) -------------------- */
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    const secret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!sig) {
      console.log("🤷 署名なしアクセス（/webhook）");
      return res.status(200).end();
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, secret);
      console.log("✅ Webhook受信:", event.type);
    } catch (err) {
      console.error("❌ 検証エラー:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    const seenRef = db.collection("stripe_events").doc(event.id);
    const seen = await seenRef.get();
    if (seen.exists) {
      console.log("↩️ 既処理:", event.id);
      return res.json({ received: true });
    }

    try {
      switch (event.type) {
        case "customer.subscription.updated": {
          const sub = event.data.object;
          const userId = await resolveUserIdFromSub(sub);
          const willCancel = !!sub.cancel_at_period_end || !!sub.cancel_at;
          const cancelAtSec = sub.cancel_at || sub.current_period_end || null;

          if (userId) {
            await db.collection("users").doc(userId).set(
              {
                cancelPending: willCancel || null,
                cancelAt: tsFromSec(cancelAtSec),
                ...(sub.current_period_end
                  ? { premiumUntil: tsFromSec(sub.current_period_end) }
                  : {}),
              },
              { merge: true }
            );
          }
          break;
        }

        case "checkout.session.completed": {
          const session = event.data.object;
          const userId = session.metadata?.userId;
          if (userId) {
            const customerId =
              typeof session.customer === "string"
                ? session.customer
                : session.customer?.id || null;
            const subscriptionId =
              typeof session.subscription === "string"
                ? session.subscription
                : session.subscription?.id || null;

            let premiumUntilTs = null;
            try {
              if (session.mode === "subscription" && session.subscription) {
                const sub =
                  typeof session.subscription === "string"
                    ? await stripe.subscriptions.retrieve(session.subscription)
                    : session.subscription;
                if (sub?.current_period_end) {
                  premiumUntilTs = tsFromSec(sub.current_period_end);
                }
              }
            } catch (e) {
              console.warn("⚠️ subscription取得失敗:", e.message);
            }

            await db.collection("users").doc(userId).set(
              {
                premium: true,
                premiumSince: admin.firestore.FieldValue.serverTimestamp(),
                ...(premiumUntilTs ? { premiumUntil: premiumUntilTs } : {}),
                ...(customerId ? { stripeCustomerId: customerId } : {}),
                ...(subscriptionId ? { lastSubscriptionId: subscriptionId } : {}),
                cancelPending: null,
                cancelAt: null,
              },
              { merge: true }
            );
          }
          break;
        }

        case "invoice.payment_succeeded": {
          const inv = event.data.object;
          const userId = await resolveUserIdFromInvoice(inv);
          const periodEndSec =
            inv?.lines?.data?.[0]?.period?.end || inv?.period_end || null;

          if (userId && periodEndSec) {
            await db
              .collection("users")
              .doc(userId)
              .set(
                { premium: true, premiumUntil: tsFromSec(periodEndSec) },
                { merge: true }
              );
          }
          break;
        }

        case "customer.subscription.deleted": {
          const sub = event.data.object;
          const userId = await resolveUserIdFromSub(sub);
          if (userId) {
            await db.collection("users").doc(userId).set(
              {
                premium: false,
                premiumUntil: null,
                cancelPending: null,
                cancelAt: null,
              },
              { merge: true }
            );
          }
          break;
        }

        default:
          console.log(`ℹ️ 未処理イベント: ${event.type}`);
      }

      await seenRef.set({ processedAt: admin.firestore.FieldValue.serverTimestamp() });
      return res.json({ received: true });
    } catch (err) {
      console.error("🛑 エラー:", err);
      return res.status(500).end();
    }
  }
);

/* -------------------- その他ルート -------------------- */
app.use(express.json());
app.use(express.static("public"));

app.get("/billing-portal", async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) return res.status(400).send("missing userId");

    const snap = await db.collection("users").doc(String(userId)).get();
    if (!snap.exists) return res.status(404).send("user not found");

    const { stripeCustomerId } = snap.data() || {};
    if (!stripeCustomerId) return res.status(400).send("customer not linked");

    const base = "https://www.oshaberiaiko.com";
    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: `${base}/mypage.html?userId=${encodeURIComponent(userId)}`,
    });

    res.redirect(302, session.url);
  } catch (e) {
    console.error("Portal error:", e);
    res.status(500).send("portal_error");
  }
});

app.get("/api/user/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const snap = await db.collection("users").doc(id).get();
    if (!snap.exists) return res.status(404).json({ exists: false });
    const data = snap.data();

    const toISO = (v) =>
      v && typeof v.toDate === "function" ? v.toDate().toISOString() : v || null;

    res.json({
      exists: true,
      premium: !!data.premium,
      premiumSince: toISO(data.premiumSince),
      premiumUntil: toISO(data.premiumUntil),
      cancelPending: !!data.cancelPending,
      cancelAt: toISO(data.cancelAt),
    });
  } catch (e) {
    console.error("Get user error:", e);
    res.status(500).json({ error: "internal_error" });
  }
});

app.post("/create-checkout-session", async (req, res) => {
  try {
    const userId = req.body.userId || "demo-user";
    const base = "https://www.oshaberiaiko.com";
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${base}/success.html?userId=${encodeURIComponent(userId)}`,
      cancel_url: `${base}/cancel.html?userId=${encodeURIComponent(userId)}`,
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
