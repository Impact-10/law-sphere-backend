const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const admin = require("firebase-admin");
const { google } = require("googleapis");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const PDFDocument = require("pdfkit");
const stream = require("stream");

const app = express();
const PORT = process.env.PORT || 3000;

// CORS setup
const allowedOrigins = ["https://law-sphere.web.app", "http://localhost:3000"];
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  methods: ["GET", "POST", "OPTIONS"],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 204,
};

app.use(bodyParser.json());
app.use(cors(corsOptions));

// Firebase Admin Initialization
const serviceAccount = {
  type: process.env.FIREBASE_TYPE,
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL,
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// Gemini AI setup
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Main conversation for legal advice
const conversation = [
  {
    role: "user",
    parts: [
      {
        text: "You are a legal advice assistant. Provide concise, practical legal advice without disclaimers or lengthy explanations. Maintain the conversation context.",
      },
    ],
  },
];

// Google OAuth Setup
const credentials = {
  web: {
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uris: [process.env.GOOGLE_REDIRECT_URI],
  },
};

const { client_id, client_secret, redirect_uris } = credentials.web;
const oAuth2Client = new google.auth.OAuth2(
  client_id,
  client_secret,
  redirect_uris[0],
);
let oauth2Tokens = null;

// OAuth Routes
app.get("/auth/google", (req, res) => {
  if (!client_id || !client_secret) {
    return res.status(500).json({ error: "OAuth not configured" });
  }
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: [
      "https://www.googleapis.com/auth/documents",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
    redirect_uri: redirect_uris[0],
  });
  res.redirect(authUrl);
});

app.get("/auth/google/callback", async (req, res) => {
  const code = req.query.code;
  if (!code)
    return res.status(400).json({ error: "No authorization code provided" });

  try {
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);
    oauth2Tokens = tokens;

    const oauth2 = google.oauth2({ version: "v2", auth: oAuth2Client });
    const userInfo = await oauth2.userinfo.get();
    res.json({ message: "Login successful", user: userInfo.data, tokens });
  } catch (err) {
    res.status(500).json({ error: "OAuth failed", details: err.message });
  }
});

// Create Google Doc route
app.post("/create-doc", async (req, res) => {
  if (!oauth2Tokens) {
    return res
      .status(401)
      .json({ error: "Not authenticated. Please log in with Google." });
  }

  const { content } = req.body;
  if (!content) {
    return res.status(400).json({ error: "Content is required" });
  }

  oAuth2Client.setCredentials(oauth2Tokens);
  const docs = google.docs({ version: "v1", auth: oAuth2Client });

  try {
    const doc = await docs.documents.create({
      requestBody: {
        title: `Legal Advice - ${new Date().toISOString()}`,
      },
    });
    const docId = doc.data.documentId;

    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: {
        requests: [
          {
            insertText: {
              location: { index: 1 },
              text: content,
            },
          },
        ],
      },
    });

    const docUrl = `https://docs.google.com/document/d/${docId}/edit`;
    res.json({ url: docUrl });
  } catch (err) {
    console.error("Document creation error:", err.message);
    res
      .status(500)
      .json({ error: "Failed to create document", details: err.message });
  }
});

// Chat route with Firestore cache
app.post("/chat", async (req, res) => {
  const userMessage = req.body.message.toLowerCase();

  let snapshot;
  try {
    snapshot = await db
      .collection("legal_queries")
      .where("query", "==", userMessage)
      .limit(1)
      .get();
    console.log(
      "Firestore lookup for:",
      userMessage,
      "Result:",
      !snapshot.empty,
    );
  } catch (err) {
    console.error("Firestore lookup error:", err.message);
    snapshot = { empty: true };
  }

  if (!snapshot.empty) {
    const doc = snapshot.docs[0];
    const reply = doc.data().response;
    conversation.push({ role: "user", parts: [{ text: userMessage }] });
    conversation.push({ role: "model", parts: [{ text: reply }] });
    return res.json({ reply });
  }

  conversation.push({ role: "user", parts: [{ text: userMessage }] });
  if (conversation.length > 10) conversation.shift();

  try {
    const result = await model.generateContent({ contents: conversation });
    const reply = result.response.text() || "No response generated.";
    conversation.push({ role: "model", parts: [{ text: reply }] });

    await db.collection("legal_queries").add({
      query: userMessage,
      response: reply,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    const createDoc = reply.length > 50;
    res.json({ reply, createDoc });
  } catch (err) {
    console.error("AI response error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// NEW ENDPOINT: Get document fill questions
app.post("/get-document-questions", async (req, res) => {
  const { documentTitle } = req.body;

  if (!documentTitle) {
    return res.status(400).json({ error: "Document title is required" });
  }

  // Normalize document title by removing extensions
  const cleanDocumentTitle = documentTitle.replace(/\.pdf$|\.doc$/, "");
  console.log("Normalized document title for questions:", cleanDocumentTitle);

  // Create a document analysis prompt for the AI
  const documentAnalysisPrompt = `
    You are a legal document assistant. I need to create questions to help a user fill out the following legal document: "${cleanDocumentTitle}".

    Create a JSON array of questions that would be needed to fill out this document. For each question:
    1. Include a 'id' field with a unique identifier
    2. Include a 'question' field with the actual question text
    3. Include a 'fieldName' field representing what field this would fill
    4. Include a 'required' boolean field

    Format the response as a valid JSON array of objects. Only return the JSON array, nothing else.

    Example format:
    [
      {
        "id": "q1",
        "question": "What is your full legal name?",
        "fieldName": "fullName",
        "required": true
      },
      {
        "id": "q2",
        "question": "What is your current address?",
        "fieldName": "address",
        "required": true
      }
    ]

    Generate between 5-10 questions depending on the complexity of the document. Make the questions specific to the document type.
  `;

  try {
    const docAnalysisChat = model.startChat({
      history: [
        {
          role: "user",
          parts: [{ text: documentAnalysisPrompt }],
        },
      ],
    });

    const result = await docAnalysisChat.sendMessage(cleanDocumentTitle);
    let questionsText = result.response.text();

    // Extract JSON array if the response contains narrative text
    if (questionsText.includes("[") && questionsText.includes("]")) {
      const jsonStart = questionsText.indexOf("[");
      const jsonEnd = questionsText.lastIndexOf("]") + 1;
      questionsText = questionsText.substring(jsonStart, jsonEnd);
    }

    try {
      const questions = JSON.parse(questionsText);
      res.json({ questions });
    } catch (jsonError) {
      console.error(
        "JSON parsing error:",
        jsonError.message,
        "Raw text:",
        questionsText,
      );
      res.status(500).json({
        error: "Failed to parse AI response",
        details: jsonError.message,
      });
    }
  } catch (err) {
    console.error("AI document analysis error:", err.message);
    res
      .status(500)
      .json({ error: "Failed to analyze document", details: err.message });
  }
});

// NEW ENDPOINT: Generate filled document
app.post("/generate-filled-document", async (req, res) => {
  const { documentTitle, responses } = req.body;

  if (!documentTitle || !responses) {
    return res
      .status(400)
      .json({ error: "Document title and responses are required" });
  }

  // Normalize document title by removing extensions and handling case
  const cleanDocumentTitle = documentTitle
    .replace(/\.pdf$|\.doc$/, "")
    .trim()
    .toLowerCase();
  console.log("Normalized document title for generation:", cleanDocumentTitle);

  // Log all document titles in Firestore for debugging
  let templateData;
  try {
    const allDocsSnapshot = await db.collection("legal_documents").get();
    console.log("All document titles in Firestore (normalized):");
    const availableTitles = [];
    allDocsSnapshot.forEach((doc) => {
      const title = doc
        .data()
        .title.replace(/\.pdf$|\.doc$/, "")
        .toLowerCase();
      availableTitles.push(title);
      console.log(`- ${title}`);
    });

    // Check if the requested title matches any available title
    if (!availableTitles.includes(cleanDocumentTitle)) {
      return res.status(404).json({
        error: "Document template not found",
        details: `No document found with title "${cleanDocumentTitle}". Available titles: ${availableTitles.join(", ")}.`,
      });
    }

    // Look for the document with the exact title (try both with and without .pdf)
    const templateSnap = await db
      .collection("legal_documents")
      .where("title", "in", [cleanDocumentTitle, cleanDocumentTitle + ".pdf"])
      .limit(1)
      .get();

    if (templateSnap.empty) {
      return res.status(404).json({
        error: "Document template not found",
        details: `No document found with title "${cleanDocumentTitle}". Available titles: ${availableTitles.join(", ")}.`,
      });
    }

    templateData = templateSnap.docs[0].data();
    console.log("Found template:", templateData);
  } catch (err) {
    console.error("Template lookup error:", err.message);
    return res.status(500).json({
      error: "Failed to retrieve document template",
      details: err.message,
    });
  }

  // Rest of the endpoint: Fill document using AI and generate PDF
  const fillPrompt = `
    You are a legal document assistant. Fill out the following legal document titled "${cleanDocumentTitle}" using the information provided.

    Here are the user's responses:
    ${Object.entries(responses)
      .map(([field, value]) => `${field}: ${value}`)
      .join("\n")}

    Create a complete, professional legal document that follows standard format for this document type.
    The document should be properly formatted with sections, appropriate legal language, and all user information integrated naturally.

    If any critical information appears to be missing, use reasonable placeholder text and note that with [REQUIRES REVIEW: reason].
  `;

  try {
    const documentChat = model.startChat({
      history: [
        {
          role: "user",
          parts: [{ text: fillPrompt }],
        },
      ],
    });

    const result = await documentChat.sendMessage(
      "Fill the document using the above info.",
    );

    const documentContent = result.response.text();
    console.log("Generated document content:", documentContent);

    const pdfDoc = new PDFDocument();
    const buffers = [];
    pdfDoc.on("data", buffers.push.bind(buffers));

    pdfDoc.fontSize(16).text(`${cleanDocumentTitle}`, { align: "center" });
    pdfDoc.moveDown();
    pdfDoc.fontSize(12).text(documentContent);
    pdfDoc.end();

    pdfDoc.on("end", () => {
      const pdfData = Buffer.concat(buffers);
      const pdfBase64 = pdfData.toString("base64");

      db.collection("filled_documents")
        .add({
          title: cleanDocumentTitle,
          content: documentContent,
          pdfBase64: pdfBase64,
          responses: responses,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        })
        .then((docRef) => {
          console.log("Document stored in Firestore with ID:", docRef.id);
          res.json({
            message: "Document generated successfully",
            documentId: docRef.id,
            documentContent,
            pdfBase64,
          });
        })
        .catch((err) => {
          console.error("Firestore storage error:", err);
          res.json({
            message: "Document generated but not stored",
            documentContent,
            pdfBase64,
          });
        });
    });
  } catch (err) {
    console.error("Document generation error:", err.message);
    res
      .status(500)
      .json({ error: "Failed to generate document", details: err.message });
  }
});

app.get("/", (req, res) => {
  res.send("Legal Chatbot is live");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server live at http://localhost:${PORT}`);
});
