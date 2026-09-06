const express = require("express");
const multer = require("multer");
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

const DATA = path.join(__dirname, "data");
const UPLOADS = path.join(DATA, "uploads");
fs.mkdirSync(UPLOADS, { recursive: true });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

const upload = multer({
  dest: UPLOADS,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(file.mimetype);
    cb(ok ? null : new Error("Only PDF or one image (JPG/PNG/WEBP) is allowed."), ok);
  }
});

let currentJob = null;
let events = [];

function emit(type, payload = {}) {
  events.push({ id: Date.now(), type, ...payload });
  if (events.length > 100) events.shift();
}

function publicBase(req) {
  // On Render, use the public HTTPS host. Locally, this is the LAN URL when opened from a phone.
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.get("host");
  return `${proto}://${host}`;
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "AXM V2.2", time: new Date().toISOString() });
});

app.get("/api/machine-qr", async (req, res) => {
  const uploadUrl = `${publicBase(req)}/upload.html`;
  const dataUrl = await QRCode.toDataURL(uploadUrl, { width: 360, margin: 2 });
  res.json({ uploadUrl, qr: dataUrl });
});

app.get("/api/job", (req, res) => {
  res.json({ job: currentJob });
});

app.get("/api/events", (req, res) => {
  const since = Number(req.query.since || 0);
  res.json(events.filter(e => e.id > since));
});

app.post("/api/upload", upload.single("document"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Please select one PDF or one image." });

  const jobId = crypto.randomUUID();
  const original = req.file.originalname;
  const ext = path.extname(original) || (req.file.mimetype === "application/pdf" ? ".pdf" : ".img");
  const finalPath = path.join(UPLOADS, jobId + ext);
  fs.renameSync(req.file.path, finalPath);

  currentJob = {
    id: jobId,
    filename: original,
    storedFile: path.basename(finalPath),
    mimetype: req.file.mimetype,
    size: req.file.size,
    status: "received",
    color: "bw",
    sides: "single",
    amount: 0,
    paymentStatus: "unpaid",
    createdAt: new Date().toISOString()
  };
  emit("job_received", { job: currentJob });
  res.json({ ok: true, job: currentJob });
});

app.post("/api/job/options", (req, res) => {
  if (!currentJob) return res.status(404).json({ error: "No document waiting." });
  const color = req.body.color === "color" ? "color" : "bw";
  const sides = req.body.sides === "double" ? "double" : "single";
  const pages = Math.max(1, Number(req.body.pages || 1));
  const rate = color === "color" ? 5 : 2;
  const copies = Math.max(1, Number(req.body.copies || 1));
  const printedSheets = sides === "double" ? Math.ceil(pages / 2) : pages;
  const amount = rate * printedSheets * copies;

  currentJob.color = color;
  currentJob.sides = sides;
  currentJob.pages = pages;
  currentJob.copies = copies;
  currentJob.amount = amount;
  currentJob.status = "awaiting_payment";
  emit("options_selected", { job: currentJob });
  res.json({ ok: true, job: currentJob });
});

app.post("/api/payment/test-success", (req, res) => {
  if (!currentJob) return res.status(404).json({ error: "No active job." });
  currentJob.paymentStatus = "paid";
  currentJob.status = "print_ready";
  currentJob.paymentReference = "TEST-" + Date.now();
  emit("payment_verified", { job: currentJob });
  res.json({ ok: true, job: currentJob });
});

app.post("/api/print/start", (req, res) => {
  if (!currentJob) return res.status(404).json({ error: "No active job." });
  if (currentJob.paymentStatus !== "paid") return res.status(402).json({ error: "Payment is not verified." });

  currentJob.status = "printing";
  emit("printing_started", { job: currentJob });

  // This server intentionally stops before OS-printer access.
  // A future Windows printer agent can securely consume this job and call the OS printer.
  setTimeout(() => {
    if (currentJob && currentJob.id === req.body.jobId) {
      currentJob.status = "printed";
      emit("printing_completed", { job: currentJob });
    }
  }, 2500);

  res.json({ ok: true, job: currentJob });
});

app.get("/api/download/:jobId", (req, res) => {
  if (!currentJob || currentJob.id !== req.params.jobId) return res.status(404).send("File not found");
  res.download(path.join(UPLOADS, currentJob.storedFile), currentJob.filename);
});

app.use((err, req, res, next) => {
  res.status(400).json({ error: err.message || "Request failed" });
});

app.listen(PORT, HOST, () => {
  console.log("========================================");
  console.log(" AXM V2.2 SERVER IS RUNNING");
  console.log(` Computer: http://localhost:${PORT}`);
  console.log(` Port: ${PORT}`);
  console.log(" Keep this window open.");
  console.log("========================================");
});
