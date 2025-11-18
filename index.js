// index.js
import express from "express";
import Stripe from "stripe";
import dotenv from "dotenv";
import OpenAI from "openai";
import * as line from "@line/bot-sdk";
import admin from "firebase-admin";
import { createRemoteJWKSet, jwtVerify } from "jose";

import { system as aikoSystem, templates as aikoTemplates } from "./Prompt.js";
import chatRoutes from "./routes/chat.js";

dotenv.config();

/* ======================== 初期化 ======================== */
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error("❌ FIREBASE_SERVICE_ACCOUNT is not set (base64 JSON)");
  process.exit(1); // 強制終了
}
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

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};
const lineClient = new line.Client({
  channelAccessToken: lineConfig.channelAccessToken,
});

/* ======================== 共通ユーティリティ ======================== */
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

  // 安全に subscription line を探索
  const lineItems = inv?.lines?.data || [];
  const subLine =
    lineItems.find((l) => l.type === "subscription") || lineItems[0] || null;

  let sub = inv.subscription;
  if (typeof sub === "string") {
    try {
      sub = await stripe.subscriptions.retrieve(sub);
    } catch {
      sub = null;
    }
  }
  if (sub?.metadata?.userId) return sub.metadata.userId;

  const customerId =
    typeof inv.customer === "string" ? inv.customer : inv.customer?.id;
  return await resolveUserIdFromCustomerId(customerId);
}

// JST の「本日」（無料回数カウント用キー）
function jstTodayKey() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(jst.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}
// Premium 判定
function isPremiumFromData(data) {
  if (!data) return false;
  const p = !!data.premium;
  const until = data.premiumUntil?.toDate ? data.premiumUntil.toDate() : null;
  if (!p) return false;
  if (!until) return true;
  return until.getTime() > Date.now();
}
/* ======================== n8n認証ミドルウェア ======================== */
const authenticateN8n = (req, res, next) => {
  // 食材APIとプロフィールAPIへのアクセスは認証スキップ
  if (req.path.includes('/ingredients') || req.path.includes('/profile')) {
    console.log('⚠️ Ingredients/Profile API access - skipping auth');
    return next();
  }
  
  const token = req.headers["x-n8n-token"];
  
  if (!token || token !== process.env.N8N_SHARED_SECRET) {
    console.warn("🚫 Unauthorized n8n access attempt");
    return res.status(403).json({ error: "forbidden" });
  }
  
  console.log("✅ n8n authentication successful");
  next();
};

/* ============ Rich Menu 切替（SDK利用でfetch不要） ============ */
async function linkRichMenuIdToUser(userId, richMenuId) {
  if (!userId || !richMenuId) return;
  try {
    await lineClient.linkRichMenuToUser(userId, richMenuId);
    console.log(`✅ RichMenu '${richMenuId}' linked to user=${userId}`);
  } catch (e) {
    console.error("RichMenu link error:", e?.response?.data || e.message || e);
  }
}

/* ======================== 会話コア ======================== */
async function chatWithAiko({ userId, text }) {
  const userSnap = await db.collection("users").doc(String(userId)).get();
  const userData = userSnap.exists ? userSnap.data() : {};
  const premium = isPremiumFromData(userData);

  const dayKey = jstTodayKey();
  const usageRef = db.collection("usage_daily").doc(`${userId}_${dayKey}`);
  const LIMIT = 3; // 無料上限

  if (!premium) {
    const usageSnap = await usageRef.get();
    const used = usageSnap.exists ? usageSnap.data().count || 0 : 0;
    if (used >= LIMIT) {
      return {
        reply:
          "今日はもう3回おしゃべりしたから終了だよ🥲 また明日ね！\nもっと話したい人向けに「プレミアム」もあるよ✨",
        premium: false,
        limited: true,
      };
    }
  }

  // 危険語検出：正規化して取りこぼしを減らす
  const norm = (s) => (s || "").toString().normalize("NFKC").toLowerCase();
  const dangerWords = [
    "死にたい",
    "消えたい",
    "自殺",
    "傷つける",
    "虐待",
    "危ない",
    "首を",
    "窒息",
    "飛び降り",
    "殺す",
    "自傷",
  ].map((w) => norm(w));
  const safetyTriggered = dangerWords.some((w) => norm(text).includes(w));

  const opener =
    aikoTemplates?.openers?.length && !safetyTriggered
      ? aikoTemplates.openers[
          Math.floor(Math.random() * aikoTemplates.openers.length)
        ]
      : null;

  const messages = [
    { role: "system", content: aikoSystem },
    ...(opener ? [{ role: "assistant", content: opener }] : []),
    { role: "user", content: text },
  ];

  // OpenAI失敗時はフォールバックを返し、回数はカウントしない
  let reply =
    "いま少し混み合っているみたい…もう一度だけ試してくれる？🙏";
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages,
      max_tokens: premium ? 400 : 220,
      temperature: safetyTriggered ? 0.2 : 0.8,
    });
    reply = completion.choices?.[0]?.message?.content?.trim() || "……";
  } catch (e) {
    console.error("OpenAI error:", e);
    return { reply, premium, limited: false };
  }

  if (!premium) {
    await usageRef.set(
      {
        count: admin.firestore.FieldValue.increment(1),
        userId,
        dayKey,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }

  return { reply, premium, limited: false };
}

/* ======================== Stripeイベント処理 ======================== */
async function handleStripeEvent(event) {
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
        await linkRichMenuIdToUser(
          userId,
          willCancel
            ? process.env.RICHMENU_ID_REGULAR || ""
            : process.env.RICHMENU_ID_PREMIUM || ""
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
        if (sub?.current_period_end)
          premiumUntilTs = tsFromSec(sub.current_period_end);
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

    // 🆕 n8n用のmembershipも更新
    await db
      .collection("conversations")
      .doc(userId)
      .collection("membership")
      .doc("info")
      .set({
        tier: "premium",
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
        created_at: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

    console.log(`✅ n8n membership updated for user=${userId}`);
    console.log(`✅ checkout.session.completed processed for user=${userId}`);

    await linkRichMenuIdToUser(
      userId,
      process.env.RICHMENU_ID_PREMIUM || ""
    );
  }
  break;
}
    case "invoice.payment_succeeded": {
      const inv = event.data.object;
      const userId = await resolveUserIdFromInvoice(inv);

      // lineアイテムから期間終了を堅牢に取得
      const lineItems = inv?.lines?.data || [];
      const subLine =
        lineItems.find((l) => l.type === "subscription") || lineItems[0] || {};
      const periodEndSec =
        subLine?.period?.end || inv?.period_end || null;

      if (userId && periodEndSec) {
        await db.collection("users").doc(userId).set(
          { premium: true, premiumUntil: tsFromSec(periodEndSec) },
          { merge: true }
        );
        console.log(`✅ invoice.payment_succeeded processed for user=${userId}`);

        await linkRichMenuIdToUser(
          userId,
          process.env.RICHMENU_ID_PREMIUM || ""
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
        console.log(`✅ subscription.deleted processed for user=${userId}`);

        await linkRichMenuIdToUser(
          userId,
          process.env.RICHMENU_ID_REGULAR || ""
        );
      }
      break;
    }
    default:
      console.log(`ℹ️ 未処理イベント: ${event.type}`);
      break;
  }
}

/* ===========================================================
   🚨 重要：Stripe Webhook は express.json() よりも前に定義
   =========================================================== */

// 本番/ダッシュボードのWebhook（先にロック→処理→完了の順）
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    const secret = process.env.STRIPE_WEBHOOK_SECRET;

    console.log("[WB] path=/webhook");
    console.log("[WB] sig header exists:", !!sig);
    console.log("[WB] isBuffer:", Buffer.isBuffer(req.body), "len:", req.body?.length);
    console.log("[WB] content-type:", req.headers["content-type"]);

    if (!sig) {
      console.warn("🚫 Non-Stripe access to /webhook");
      return res.status(403).send("forbidden");
    }

    try {
      const event = stripe.webhooks.constructEvent(req.body, sig, secret);
      res.status(200).send("ok");

      const seenRef = db.collection("stripe_events").doc(event.id);
      const seen = await seenRef.get();
      if (seen.exists && (seen.data()?.processedAt || seen.data()?.lockedAt)) return;

      // 先にロックを書き込む
      await seenRef.set(
        { lockedAt: admin.firestore.FieldValue.serverTimestamp(), type: event.type },
        { merge: true }
      );

      await handleStripeEvent(event);

      await seenRef.set(
        { processedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
    } catch (err) {
      console.error("❌ 本番Webhook署名エラー:", err.message);
      if (!res.headersSent) res.status(400).send("bad signature");
    }
  }
);

// Stripe CLI専用のWebhook（同様にロック→処理→完了）
app.post(
  "/webhook-cli",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    const secret = process.env.STRIPE_CLI_WEBHOOK_SECRET;
    if (!sig) {
      console.warn("🚫 Non-Stripe access to /webhook-cli");
      return res.status(403).send("forbidden");
    }
    try {
      const event = stripe.webhooks.constructEvent(req.body, sig, secret);
      res.status(200).send("ok");

      const seenRef = db.collection("stripe_events").doc(event.id);
      const seen = await seenRef.get();
      if (seen.exists && (seen.data()?.processedAt || seen.data()?.lockedAt)) return;

      await seenRef.set(
        { lockedAt: admin.firestore.FieldValue.serverTimestamp(), type: event.type },
        { merge: true }
      );

      console.log("✅ CLI Webhook受信:", event.type);
      await handleStripeEvent(event);

      await seenRef.set(
        { processedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
    } catch (err) {
      console.error("❌ CLI署名検証エラー:", err.message);
      if (!res.headersSent) res.status(400).send("bad signature");
    }
  }
);

/* ======================== LINE Webhook ======================== */
app.post("/line-webhook", line.middleware(lineConfig), async (req, res) => {
  try {
    const events = req.body.events || [];
    await Promise.all(
      events.map(async (event) => {
        if (event.type === "message" && event.message?.type === "text") {
          const userId = event.source?.userId;
          const text = event.message.text || "";
          if (!userId || !text) return;
          const result = await chatWithAiko({ userId, text });
          await lineClient.replyMessage(event.replyToken, {
            type: "text",
            text: result.reply,
          });
        }
      })
    );
    res.status(200).end();
  } catch (e) {
    console.error("LINE webhook error:", e);
    res.status(500).end();
  }
});

/* ============ LIFF: IDトークン検証 & Checkout 作成/解決 ============ */
const LINE_ISSUER = "https://access.line.me";
const LINE_JWKS = createRemoteJWKSet(
  new URL("https://api.line.me/oauth2/v2.1/certs")
);

async function verifyLineIdToken(idToken) {
  try {
    const channelId = process.env.LINE_LOGIN_CHANNEL_ID;
    if (!channelId) {
      throw new Error("LINE_LOGIN_CHANNEL_ID not configured");
    }

    console.log("🔍 Verifying ID token");
    console.log("   - Expected Channel ID:", channelId);

    // デバッグ用：トークンのペイロードを先に確認
    try {
      const parts = idToken.split(".");
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], "base64").toString());
        console.log("   - Token aud:", payload.aud);
        console.log("   - Token iss:", payload.iss);
        console.log("   - Token exp:", new Date(payload.exp * 1000).toISOString());
        console.log("   - Current time:", new Date().toISOString());
        
        const nowSec = Math.floor(Date.now() / 1000);
        const expSec = payload.exp;
        const timeDiff = expSec - nowSec;
        console.log("   - Time difference:", timeDiff, "seconds");
        
        // 事前チェック：audが一致しない場合は早期に詳細エラーを返す
        if (payload.aud !== channelId) {
          throw new Error(
            `Channel ID mismatch: expected ${channelId}, got ${payload.aud}. ` +
            `LIFFのチャネルIDとLINE_LOGIN_CHANNEL_IDを一致させてください。`
          );
        }
      }
    } catch (decodeError) {
      // デコードエラーは無視してjwtVerifyに任せる
      if (decodeError.message.includes('Channel ID mismatch')) {
        throw decodeError; // Channel ID不一致は再スロー
      }
      console.error("   - Token decode error:", decodeError.message);
    }

    const { payload } = await jwtVerify(idToken, LINE_JWKS, {
      issuer: LINE_ISSUER,
      audience: channelId,
      clockTolerance: 600, // 10分まで許容（LIFFの遅延を考慮）
    });

    console.log("✅ ID Token verified successfully");
    console.log("   - User ID (sub):", payload.sub);

    return payload;
  } catch (error) {
    console.error("❌ ID Token verification failed:");
    console.error("   - Error name:", error.name);
    console.error("   - Error message:", error.message);
    console.error("   - Error code:", error.code);

    throw error;
  }
}

// 公開設定を返す（LIFF ID）- キャッシュ無効化
app.get("/api/config", (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.json({
    liffId: process.env.LIFF_ID_PAY || process.env.LIFF_ID || "",
    liffIdPay: process.env.LIFF_ID_PAY || "",
    liffIdMypage: process.env.LIFF_ID_MYPAGE || "",
  });
});

// idToken → userId を返す（マイページ用）
app.post("/api/resolve-user", express.json(), async (req, res) => {
  try {
    const { idToken } = req.body || {};
    console.log("🔍 /api/resolve-user called");
    console.log(
      "   - ID Token received:",
      idToken ? "YES (length: " + idToken.length + ")" : "NO"
    );

    if (!idToken) {
      console.warn("⚠️ Missing idToken in request");
      return res.status(400).json({ error: "missing idToken" });
    }

    const payload = await verifyLineIdToken(idToken);
    console.log("✅ User resolved:", payload.sub);

    return res.json({ userId: payload.sub });
  } catch (e) {
    console.error("❌ /api/resolve-user error:", e.message);
    return res.status(401).json({
      error: "invalid_token",
      details: e.message,
      hint: "LIFF設定とLINE_LOGIN_CHANNEL_IDを確認してください",
    });
  }
});

// LIFF経由のCheckout作成（userIdメタデータ付与）
app.post("/create-checkout-session/liff", express.json(), async (req, res) => {
  try {
    const { idToken } = req.body || {};
    console.log("🔍 /create-checkout-session/liff called");
    console.log("   - ID Token received:", idToken ? "YES" : "NO");

    if (!idToken) {
      console.warn("⚠️ Missing idToken in checkout request");
      return res.status(400).json({ error: "missing idToken" });
    }

    const payload = await verifyLineIdToken(idToken);
    const userId = payload.sub;
    console.log("✅ Creating checkout for user:", userId);

    // 🔒 二重課金ガード：すでにプレミアムならCheckoutを発行しない
    const snap = await db.collection("users").doc(String(userId)).get();
    const data = snap.exists ? snap.data() : {};
    if (isPremiumFromData(data)) {
      return res.status(409).json({
        error: "already_premium",
        details: "User already has an active subscription",
        redirectUrl: "https://menu-planner-express.onrender.com", // レシピアプリへ
      });
    }

    const base = process.env.PUBLIC_ORIGIN || "https://www.oshaberiaiko.com";
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${base}/success.html?userId=${encodeURIComponent(userId)}`,
      cancel_url: `${base}/cancel.html?userId=${encodeURIComponent(userId)}`,
      metadata: { userId },
      subscription_data: { metadata: { userId } },
    });

    console.log("✅ Checkout session created:", session.id);
    return res.json({ url: session.url });
  } catch (e) {
    console.error("❌ LIFF checkout error:", e.message);
    return res.status(401).json({
      error: "invalid_token",
      details: e.message,
    });
  }
});

/* ======================== ここから通常ミドルウェア ======================== */
// ⬇️ これ以降に JSON パーサを置く（Stripeのraw受信と衝突しない）
app.use(express.json());

// キャッシュ無効化ミドルウェア（全リクエストに適用）
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

app.use(express.static("public"));

/* ======================== n8n Chat API ======================== */
// 食材APIは認証なしで許可（マイページからのアクセスのため）
app.get("/api/chat/:uid/ingredients", chatRoutes);
app.post("/api/chat/:uid/ingredients", chatRoutes);

// membership情報取得API（n8n用）← ここに移動！
app.get("/api/chat/:uid/membership", authenticateN8n, async (req, res) => {
  try {
    const userId = req.params.uid;
    console.log('📊 Membership取得:', userId);
    
    const membershipSnap = await db
      .collection("conversations")
      .doc(userId)
      .collection("membership")
      .doc("info")
      .get();
    
    if (!membershipSnap.exists) {
      console.log('⚠️ Membership未登録 - regularとして扱う');
      return res.json({ tier: "regular", exists: false });
    }
    
    const data = membershipSnap.data();
    console.log('✅ Membership取得成功:', data.tier);
    
    return res.json({
      tier: data.tier || "regular",
      exists: true,
      updated_at: data.updated_at
    });
  } catch (e) {
    console.error("❌ membership取得エラー:", e);
    return res.status(500).json({ error: "internal_error" });
  }
});

// その他のChat APIはn8n認証必須
app.use("/api/chat", authenticateN8n, chatRoutes);

/* ======================== 管理用：手動リッチメニュー切替（任意） ======================== */
app.post("/admin/switch-richmenu", express.json(), async (req, res) => {
  try {
    const { userId, plan, key } = { ...req.query, ...req.body };
    if (!key || key !== process.env.ADMIN_KEY)
      return res.status(403).json({ error: "forbidden" });
    if (!userId || !plan)
      return res.status(400).json({ error: "missing userId or plan" });

    const richMenuId =
      plan === "premium"
        ? process.env.RICHMENU_ID_PREMIUM || ""
        : process.env.RICHMENU_ID_REGULAR || "";

    if (!richMenuId)
      return res.status(400).json({ error: "missing richmenu id env" });

    await linkRichMenuIdToUser(userId, richMenuId);

    // 監査ログ（任意）
    try {
      await db.collection("admin_actions").add({
        action: "switch-richmenu",
        at: admin.firestore.FieldValue.serverTimestamp(),
        userId,
        plan,
        ip: req.ip,
      });
    } catch (e) {
      console.warn("audit log failed:", e.message);
    }

    res.json({ ok: true, linked: richMenuId, userId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal_error" });
  }
});

/* ======================== 通常ルート ======================== */
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, version: process.env.GIT_COMMIT || "local" });
});

app.get("/api/hello", (_req, res) => {
  res.json({ message: "Hello from API" });
});

app.get("/", (_req, res) => res.send("OK"));

app.get("/billing-portal", async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) return res.status(400).send("missing userId");
    const snap = await db.collection("users").doc(String(userId)).get();
    if (!snap.exists) return res.status(404).send("user not found");
    const { stripeCustomerId } = snap.data() || {};
    if (!stripeCustomerId) return res.status(400).send("customer not linked");

    const base = process.env.PUBLIC_ORIGIN || "https://www.oshaberiaiko.com";
    // ★ ここを mypage-link.html に統一
    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: `${base}/mypage-link.html?userId=${encodeURIComponent(userId)}`,
    });
    res.redirect(302, session.url);
  } catch (e) {
    console.error("Portal error:", e);
    res.status(500).send("portal_error");
  }
});

app.get("/api/user/:id", async (req, res) => {
  try {
    // キャッシュ無効化ヘッダー
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    
    const id = req.params.id;
    const snap = await db.collection("users").doc(id).get();
    
    // ユーザーが存在しない場合でも基本情報を返す
    if (!snap.exists) {
      return res.json({
        exists: false,
        premium: false,
        premiumSince: null,
        premiumUntil: null,
        cancelPending: false,
        cancelAt: null,
      });
    }
    
    const data = snap.data();
    const toISO = (v) =>
      v && typeof v.toDate === "function" ? v.toDate().toISOString() : v || null;
    res.json({
      exists: true,
      premium: isPremiumFromData(data),
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
    const userId = req.body?.userId || "demo-user";
    const base = process.env.PUBLIC_ORIGIN || "https://www.oshaberiaiko.com";
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

app.post("/api/chat", authenticateN8n, async (req, res) => {
  try {
    const { userId, message } = req.body || {};
    if (!userId || !message)
      return res.status(400).json({ error: "missing userId or message" });
    
    const result = await chatWithAiko({ userId, text: message });
    
    // limited の場合も 200 で返す
    if (result.limited) {
      return res.status(200).json(result); // 429 ではなく 200
    }
    
    return res.json(result);
  } catch (e) {
    console.error("Chat error:", e);
    return res.status(500).json({ error: "internal_error" });
  }
});

app.listen(port, () => console.log(`Server on :${port}`));
