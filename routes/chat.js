// routes/chat.js
import express from "express";
import admin from "firebase-admin";
import jwt from "jsonwebtoken";
import jwksClient from "jwks-rsa";

const router = express.Router();

// LINE IDトークン検証用クライアント
const client = jwksClient({
  jwksUri: 'https://api.line.me/oauth2/v2.1/certs',
  cache: true,
  rateLimit: true
});

// 公開鍵取得関数
function getKey(header, callback) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) {
      callback(err);
    } else {
      const signingKey = key.publicKey || key.rsaPublicKey;
      callback(null, signingKey);
    }
  });
}

// トークン検証ミドルウェア
const verifyTokenOptional = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const n8nToken = req.headers['x-n8n-token'];
  
  // n8nからのリクエストは従来通り許可
  if (n8nToken === process.env.N8N_SHARED_SECRET) {
    req.authenticated = true;
    return next();
  }
  
  // Authorizationヘッダーがない場合はスキップ
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.authenticated = false;
    return next();
  }
  
  const token = authHeader.split(' ')[1];
  
  try {
    // LINE IDトークンを検証
    const decoded = await new Promise((resolve, reject) => {
      jwt.verify(token, getKey, {
        algorithms: ['RS256'],
        audience: process.env.LINE_LOGIN_CHANNEL_ID,
        issuer: 'https://access.line.me'
      }, (err, decoded) => {
        if (err) reject(err);
        else resolve(decoded);
      });
    });
    
    req.authenticated = true;
    req.lineUserId = decoded.sub;
    next();
  } catch (error) {
    console.error('Token verification failed:', error.message);
    req.authenticated = false;
    next();
  }
};

// 会話履歴取得
router.get("/:uid/history", async (req, res) => {
  try {
    const db = admin.firestore();
    const { uid } = req.params;
    const limit = parseInt(req.query.limit) || 10;

    console.log(`📖 Fetching history for user: ${uid}, limit: ${limit}`);

    const messagesRef = db
      .collection("conversations")
      .doc(uid)
      .collection("messages")
      .orderBy("timestamp", "desc")
      .limit(limit);

    const snapshot = await messagesRef.get();

    if (snapshot.empty) {
      console.log(`ℹ️ No history found for user: ${uid}`);
      return res.json({ messages: [] });
    }

    const messages = [];
    snapshot.forEach((doc) => {
      const data = doc.data();
      messages.push({
        id: doc.id,
        role: data.role,
        content: data.content,
        timestamp: data.timestamp?.toDate
          ? data.timestamp.toDate().toISOString()
          : null,
        message_id: data.message_id || null,
      });
    });

    messages.reverse();

    console.log(`✅ Found ${messages.length} messages for user: ${uid}`);
    res.json({ messages });
  } catch (error) {
    console.error("❌ Error fetching history:", error);
    res.status(500).json({ error: "internal_server_error" });
  }
});

// メッセージ保存
router.post("/:uid/message", async (req, res) => {
  try {
    const db = admin.firestore();
    const { uid } = req.params;
    const { role, content, message_id } = req.body;

    if (!role || !content) {
      return res.status(400).json({ error: "missing_required_fields" });
    }

    if (!["user", "assistant"].includes(role)) {
      return res.status(400).json({ error: "invalid_role" });
    }

    console.log(`💾 Saving message for user: ${uid}, role: ${role}`);

    const messageData = {
      role,
      content,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (message_id) {
      messageData.message_id = message_id;
    }

    const docRef = await db
      .collection("conversations")
      .doc(uid)
      .collection("messages")
      .add(messageData);

    console.log(`✅ Message saved: ${docRef.id}`);
    res.json({
      success: true,
      id: docRef.id,
    });
  } catch (error) {
    console.error("❌ Error saving message:", error);
    res.status(500).json({ error: "internal_server_error" });
  }
});

// プロフィール取得
router.get("/:uid/profile", async (req, res) => {
  try {
    const db = admin.firestore();
    const { uid } = req.params;

    console.log(`📖 Fetching profile for user: ${uid}`);

    const profileRef = db
      .collection("conversations")
      .doc(uid)
      .collection("profile")
      .doc("info");

    const profileDoc = await profileRef.get();

    if (!profileDoc.exists) {
      console.log(`ℹ️ No profile found for user: ${uid}`);
      return res.json({ exists: false, profile: null });
    }

    const profileData = profileDoc.data();

    console.log(`✅ Profile found for user: ${uid}`);
    res.json({
      exists: true,
      profile: {
        ...profileData,
        created_at: profileData.created_at?.toDate
          ? profileData.created_at.toDate().toISOString()
          : null,
        updated_at: profileData.updated_at?.toDate
          ? profileData.updated_at.toDate().toISOString()
          : null,
      },
    });
  } catch (error) {
    console.error("❌ Error fetching profile:", error);
    res.status(500).json({ error: "internal_server_error" });
  }
});

// プロフィール保存
router.post("/:uid/profile", async (req, res) => {
  try {
    const db = admin.firestore();
    const { uid } = req.params;
    const profileData = req.body;

    console.log(`💾 Saving profile for user: ${uid}`);

    const profileRef = db
      .collection("conversations")
      .doc(uid)
      .collection("profile")
      .doc("info");

    const data = {
      ...profileData,
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    };

    const existingProfile = await profileRef.get();
    if (!existingProfile.exists) {
      data.created_at = admin.firestore.FieldValue.serverTimestamp();
    }

    await profileRef.set(data, { merge: true });

    console.log(`✅ Profile saved for user: ${uid}`);
    res.json({ success: true });
  } catch (error) {
    console.error("❌ Error saving profile:", error);
    res.status(500).json({ error: "internal_server_error" });
  }
});

// 会員種別取得
router.get("/:uid/membership", async (req, res) => {
  try {
    const db = admin.firestore();
    const { uid } = req.params;

    console.log(`👤 Fetching membership for user: ${uid}`);

    const membershipRef = db
      .collection("conversations")
      .doc(uid)
      .collection("membership")
      .doc("info");

    const membershipDoc = await membershipRef.get();

    if (!membershipDoc.exists) {
      console.log(`ℹ️ No membership found, defaulting to free tier`);
      return res.json({ 
        exists: false, 
        tier: "free"
      });
    }

    const membershipData = membershipDoc.data();

    console.log(`✅ Membership found: ${membershipData.tier}`);
    res.json({
      exists: true,
      tier: membershipData.tier,
      created_at: membershipData.created_at?.toDate
        ? membershipData.created_at.toDate().toISOString()
        : null,
      updated_at: membershipData.updated_at?.toDate
        ? membershipData.updated_at.toDate().toISOString()
        : null,
    });
  } catch (error) {
    console.error("❌ Error fetching membership:", error);
    res.status(500).json({ error: "internal_server_error" });
  }
});

// 会員種別更新
router.post("/:uid/membership", async (req, res) => {
  try {
    const db = admin.firestore();
    const { uid } = req.params;
    const { tier } = req.body;

    if (!["free", "premium"].includes(tier)) {
      return res.status(400).json({ error: "invalid_tier" });
    }

    console.log(`💳 Updating membership for user: ${uid} to ${tier}`);

    const membershipRef = db
      .collection("conversations")
      .doc(uid)
      .collection("membership")
      .doc("info");

    const data = {
      tier,
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    };

    const existingMembership = await membershipRef.get();
    if (!existingMembership.exists) {
      data.created_at = admin.firestore.FieldValue.serverTimestamp();
    }

    await membershipRef.set(data, { merge: true });

    console.log(`✅ Membership updated to ${tier}`);
    res.json({ success: true, tier });
  } catch (error) {
    console.error("❌ Error updating membership:", error);
    res.status(500).json({ error: "internal_server_error" });
  }
});

// 食材リストを取得
router.get('/:uid/ingredients', verifyTokenOptional, async (req, res) => {
  try {
    const db = admin.firestore();
    const userId = req.params.uid;

    console.log('📖 食材リスト取得:', userId);

    // 認証チェック（マイページからのアクセス）
    if (req.authenticated && req.lineUserId && req.lineUserId !== userId) {
      console.error('❌ ユーザーID不一致');
      return res.status(403).json({
        success: false,
        error: 'forbidden'
      });
    }

    const ingredientsRef = db
      .collection('conversations')
      .doc(userId)
      .collection('ingredients')
      .doc('current');

    const doc = await ingredientsRef.get();

    if (!doc.exists) {
      return res.json({
        success: true,
        ingredients: [],
        notes: '',
        exists: false
      });
    }

    const data = doc.data();
    res.json({
      success: true,
      ingredients: data.ingredients || [],
      notes: data.notes || '',
      updated_at: data.updated_at?.toDate
        ? data.updated_at.toDate().toISOString()
        : null,
      exists: true
    });

  } catch (error) {
    console.error('❌ 食材リスト取得エラー:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 食材リストを保存
router.post('/:uid/ingredients', verifyTokenOptional, async (req, res) => {
  try {
    const db = admin.firestore();
    const userId = req.params.uid;
    const { ingredients, notes } = req.body;

    console.log('🥬 食材リスト保存:', userId);

    // 認証チェック（マイページからのアクセス）
    if (req.authenticated && req.lineUserId && req.lineUserId !== userId) {
      console.error('❌ ユーザーID不一致');
      return res.status(403).json({
        success: false,
        error: 'forbidden'
      });
    }

    console.log('📦 受信データ:', { 
      ingredientsCount: ingredients?.length, 
      notes: notes 
    });

    // バリデーション
    if (!ingredients || !Array.isArray(ingredients)) {
      console.error('❌ 無効なデータ形式');
      return res.status(400).json({
        success: false,
        error: 'ingredients must be an array'
      });
    }

    const ingredientsRef = db
      .collection('conversations')
      .doc(userId)
      .collection('ingredients')
      .doc('current');

    console.log('💾 Firestoreに書き込み中...');

    await ingredientsRef.set({
      ingredients: ingredients,
      notes: notes || '',
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
      created_at: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    console.log('✅ 食材リスト保存成功');

    res.json({
      success: true,
      message: '食材リストを保存しました',
      ingredientsCount: ingredients.length
    });

  } catch (error) {
    console.error('❌ 食材リスト保存エラー:', error);
    console.error('エラー詳細:', error.stack);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
