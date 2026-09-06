const express = require("express");
const multer = require("multer");
const QRCode = require("qrcode");
const Razorpay = require("razorpay");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

// ======================================================
// RAZORPAY CONFIGURATION
// ======================================================

const RAZORPAY_KEY_ID =
  String(process.env.RAZORPAY_KEY_ID || "").trim();

const RAZORPAY_KEY_SECRET =
  String(process.env.RAZORPAY_KEY_SECRET || "").trim();

let razorpay = null;

if (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({
    key_id: RAZORPAY_KEY_ID,
    key_secret: RAZORPAY_KEY_SECRET
  });

  console.log("Razorpay: CONFIGURED");
} else {
  console.log("Razorpay: NOT CONFIGURED");
}

// ======================================================
// DIRECTORIES
// ======================================================

const DATA = path.join(__dirname, "data");
const UPLOADS = path.join(DATA, "uploads");

fs.mkdirSync(UPLOADS, {
  recursive: true
});

// ======================================================
// MIDDLEWARE
// ======================================================

app.use(express.json());

app.use(
  express.urlencoded({
    extended: true
  })
);

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

// ======================================================
// FILE UPLOAD
// ======================================================

const upload = multer({
  dest: UPLOADS,

  limits: {
    fileSize: 25 * 1024 * 1024
  },

  fileFilter: (req, file, cb) => {

    const allowed = [
      "application/pdf",
      "image/jpeg",
      "image/png",
      "image/webp"
    ];

    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          "Only PDF or one image (JPG/PNG/WEBP) is allowed."
        )
      );
    }
  }
});

// ======================================================
// JOB / EVENTS
// ======================================================

let currentJob = null;
let events = [];

function emit(type, payload = {}) {

  events.push({
    id: Date.now(),
    type,
    ...payload
  });

  if (events.length > 100) {
    events.shift();
  }
}

// ======================================================
// PUBLIC URL
// ======================================================

function publicBase(req) {

  const proto =
    req.headers["x-forwarded-proto"] ||
    req.protocol;

  const host =
    req.get("host");

  return `${proto}://${host}`;
}

// ======================================================
// HEALTH CHECK
// ======================================================

app.get(
  "/api/health",
  (req, res) => {

    res.json({
      ok: true,

      service:
        "AXM V2.3",

      razorpayConfigured:
        Boolean(razorpay),

      keyIdConfigured:
        Boolean(RAZORPAY_KEY_ID),

      secretConfigured:
        Boolean(RAZORPAY_KEY_SECRET),

      time:
        new Date().toISOString()
    });
  }
);

// ======================================================
// MACHINE QR
// ======================================================

app.get(
  "/api/machine-qr",
  async (req, res) => {

    try {

      const uploadUrl =
        `${publicBase(req)}/upload.html`;

      const qr =
        await QRCode.toDataURL(
          uploadUrl,
          {
            width: 360,
            margin: 2
          }
        );

      res.json({
        ok: true,
        uploadUrl,
        qr
      });

    } catch (error) {

      console.error(
        "Machine QR error:",
        error
      );

      res.status(500).json({
        error:
          "Unable to create QR code."
      });
    }
  }
);

// ======================================================
// CURRENT JOB
// ======================================================

app.get(
  "/api/job",
  (req, res) => {

    res.json({
      job: currentJob
    });
  }
);

// ======================================================
// EVENTS
// ======================================================

app.get(
  "/api/events",
  (req, res) => {

    const since =
      Number(req.query.since || 0);

    res.json(
      events.filter(
        event =>
          event.id > since
      )
    );
  }
);

// ======================================================
// UPLOAD DOCUMENT
// ======================================================

app.post(
  "/api/upload",
  upload.single("document"),
  (req, res) => {

    if (!req.file) {

      return res.status(400).json({
        error:
          "Please select one PDF or one image."
      });
    }

    const jobId =
      crypto.randomUUID();

    const original =
      req.file.originalname;

    const ext =
      path.extname(original) ||
      (
        req.file.mimetype ===
        "application/pdf"
          ? ".pdf"
          : ".img"
      );

    const finalPath =
      path.join(
        UPLOADS,
        jobId + ext
      );

    fs.renameSync(
      req.file.path,
      finalPath
    );

    currentJob = {

      id:
        jobId,

      filename:
        original,

      storedFile:
        path.basename(finalPath),

      mimetype:
        req.file.mimetype,

      size:
        req.file.size,

      status:
        "received",

      color:
        "bw",

      sides:
        "single",

      pages:
        1,

      copies:
        1,

      amount:
        0,

      paymentStatus:
        "unpaid",

      razorpayOrderId:
        null,

      paymentReference:
        null,

      createdAt:
        new Date().toISOString()
    };

    emit(
      "job_received",
      {
        job:
          currentJob
      }
    );

    res.json({
      ok: true,
      job: currentJob
    });
  }
);

// ======================================================
// PRINT OPTIONS
// ======================================================

app.post(
  "/api/job/options",
  (req, res) => {

    if (!currentJob) {

      return res.status(404).json({
        error:
          "No document waiting."
      });
    }

    const color =
      req.body.color === "color"
        ? "color"
        : "bw";

    const sides =
      req.body.sides === "double"
        ? "double"
        : "single";

    let pages =
      Number(req.body.pages);

    let copies =
      Number(req.body.copies);

    if (!Number.isFinite(pages) || pages < 1) {
      pages = 1;
    }

    if (!Number.isFinite(copies) || copies < 1) {
      copies = 1;
    }

    pages =
      Math.floor(pages);

    copies =
      Math.floor(copies);

    const rate =
      color === "color"
        ? 5
        : 2;

    const printedSheets =
      sides === "double"
        ? Math.ceil(pages / 2)
        : pages;

    const amount =
      rate *
      printedSheets *
      copies;

    currentJob.color =
      color;

    currentJob.sides =
      sides;

    currentJob.pages =
      pages;

    currentJob.copies =
      copies;

    currentJob.amount =
      amount;

    currentJob.paymentStatus =
      "unpaid";

    currentJob.razorpayOrderId =
      null;

    currentJob.paymentReference =
      null;

    currentJob.status =
      "awaiting_payment";

    emit(
      "options_selected",
      {
        job:
          currentJob
      }
    );

    res.json({
      ok: true,
      job: currentJob
    });
  }
);

// ======================================================
// CREATE RAZORPAY ORDER
// ======================================================

app.post(
  "/api/payment/create-order",
  async (req, res) => {

    try {

      if (!currentJob) {

        return res.status(404).json({
          error:
            "No active print job."
        });
      }

      if (!razorpay) {

        return res.status(503).json({
          error:
            "Razorpay is not configured on the server. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in Render."
        });
      }

      if (
        !Number.isFinite(
          Number(currentJob.amount)
        ) ||
        Number(currentJob.amount) <= 0
      ) {

        return res.status(400).json({
          error:
            "Invalid payment amount."
        });
      }

      const amountInPaise =
        Math.round(
          Number(currentJob.amount) * 100
        );

      const receipt =
        `AXM_${Date.now()}`;

      const order =
        await razorpay.orders.create({

          amount:
            amountInPaise,

          currency:
            "INR",

          receipt:
            receipt,

          notes: {

            service:
              "AXM Automatic Xerox Machine",

            jobId:
              currentJob.id,

            filename:
              currentJob.filename,

            color:
              currentJob.color,

            sides:
              currentJob.sides,

            pages:
              String(currentJob.pages),

            copies:
              String(currentJob.copies)
          }
        });

      currentJob.razorpayOrderId =
        order.id;

      currentJob.status =
        "payment_pending";

      currentJob.paymentStatus =
        "unpaid";

      emit(
        "payment_order_created",
        {
          job:
            currentJob,

          orderId:
            order.id
        }
      );

      res.json({

        ok:
          true,

        keyId:
          RAZORPAY_KEY_ID,

        orderId:
          order.id,

        amount:
          order.amount,

        currency:
          order.currency,

        jobId:
          currentJob.id
      });

    } catch (error) {

      console.error(
        "Razorpay order error:",
        error
      );

      const message =
        error?.error?.description ||
        error?.description ||
        error?.message ||
        "Unable to create Razorpay order.";

      res.status(500).json({
        error:
          message
      });
    }
  }
);

// ======================================================
// VERIFY RAZORPAY PAYMENT
// ======================================================

app.post(
  "/api/payment/verify",
  (req, res) => {

    try {

      if (!currentJob) {

        return res.status(404).json({
          error:
            "No active print job."
        });
      }

      if (!RAZORPAY_KEY_SECRET) {

        return res.status(503).json({
          error:
            "Razorpay secret is not configured."
        });
      }

      const {
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature
      } = req.body;

      if (
        !razorpay_order_id ||
        !razorpay_payment_id ||
        !razorpay_signature
      ) {

        return res.status(400).json({
          error:
            "Incomplete Razorpay payment response."
        });
      }

      // Make sure this payment belongs
      // to the current print job.

      if (
        currentJob.razorpayOrderId !==
        razorpay_order_id
      ) {

        return res.status(400).json({
          error:
            "Razorpay order does not match this print job."
        });
      }

      const signatureBody =
        `${razorpay_order_id}|${razorpay_payment_id}`;

      const expectedSignature =
        crypto
          .createHmac(
            "sha256",
            RAZORPAY_KEY_SECRET
          )
          .update(signatureBody)
          .digest("hex");

      if (
        expectedSignature.length !==
        razorpay_signature.length
      ) {

        return res.status(400).json({
          error:
            "Payment signature verification failed."
        });
      }

      const valid =
        crypto.timingSafeEqual(
          Buffer.from(
            expectedSignature,
            "utf8"
          ),
          Buffer.from(
            razorpay_signature,
            "utf8"
          )
        );

      if (!valid) {

        currentJob.paymentStatus =
          "failed";

        currentJob.status =
          "payment_failed";

        emit(
          "payment_failed",
          {
            job:
              currentJob
          }
        );

        return res.status(400).json({
          error:
            "Payment signature verification failed."
        });
      }

      // PAYMENT SUCCESS

      currentJob.paymentStatus =
        "paid";

      currentJob.status =
        "print_ready";

      currentJob.paymentReference =
        razorpay_payment_id;

      currentJob.paymentOrderId =
        razorpay_order_id;

      currentJob.paidAt =
        new Date().toISOString();

      emit(
        "payment_verified",
        {
          job:
            currentJob,

          paymentId:
            razorpay_payment_id,

          orderId:
            razorpay_order_id
        }
      );

      res.json({

        ok:
          true,

        success:
          true,

        job:
          currentJob
      });

    } catch (error) {

      console.error(
        "Payment verification error:",
        error
      );

      res.status(500).json({
        error:
          "Payment verification failed."
      });
    }
  }
);

// ======================================================
// DEVELOPMENT TEST PAYMENT
// ======================================================

app.post(
  "/api/payment/test-success",
  (req, res) => {

    if (!currentJob) {

      return res.status(404).json({
        error:
          "No active job."
      });
    }

    currentJob.paymentStatus =
      "paid";

    currentJob.status =
      "print_ready";

    currentJob.paymentReference =
      "TEST-" + Date.now();

    emit(
      "payment_verified",
      {
        job:
          currentJob
      }
    );

    res.json({
      ok: true,
      job: currentJob
    });
  }
);

// ======================================================
// START PRINT
// ======================================================

app.post(
  "/api/print/start",
  (req, res) => {

    if (!currentJob) {

      return res.status(404).json({
        error:
          "No active job."
      });
    }

    if (
      currentJob.paymentStatus !==
      "paid"
    ) {

      return res.status(402).json({
        error:
          "Payment is not verified."
      });
    }

    if (
      req.body.jobId &&
      req.body.jobId !==
      currentJob.id
    ) {

      return res.status(400).json({
        error:
          "Job ID does not match."
      });
    }

    currentJob.status =
      "printing";

    emit(
      "printing_started",
      {
        job:
          currentJob
      }
    );

    // Temporary printer simulation.
    // Real printer connection can be added later.

    setTimeout(
      () => {

        if (currentJob) {

          currentJob.status =
            "printed";

          emit(
            "printing_completed",
            {
              job:
                currentJob
            }
          );
        }

      },
      2500
    );

    res.json({
      ok: true,
      job: currentJob
    });
  }
);

// ======================================================
// DOWNLOAD FILE
// ======================================================

app.get(
  "/api/download/:jobId",
  (req, res) => {

    if (
      !currentJob ||
      currentJob.id !==
      req.params.jobId
    ) {

      return res
        .status(404)
        .send("File not found");
    }

    const filePath =
      path.join(
        UPLOADS,
        currentJob.storedFile
      );

    if (!fs.existsSync(filePath)) {

      return res
        .status(404)
        .send("File not found");
    }

    res.download(
      filePath,
      currentJob.filename
    );
  }
);

// ======================================================
// ERROR HANDLER
// ======================================================

app.use(
  (err, req, res, next) => {

    console.error(
      "Server error:",
      err
    );

    res.status(400).json({
      error:
        err.message ||
        "Request failed"
    });
  }
);

// ======================================================
// SERVER START
// ======================================================

app.listen(
  PORT,
  HOST,
  () => {

    console.log(
      "========================================"
    );

    console.log(
      " AXM V2.3 SERVER IS RUNNING"
    );

    console.log(
      ` Port: ${PORT}`
    );

    console.log(
      ` Razorpay configured: ${Boolean(razorpay)}`
    );

    console.log(
      "========================================"
    );
  }
);
