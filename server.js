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
// RAZORPAY
// ======================================================

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

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

app.use(express.static(__dirname));


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
// PUBLIC BASE URL
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
// HEALTH
// ======================================================

app.get(
  "/api/health",
  (req, res) => {

    res.json({

      ok: true,

      service: "AXM V2.2",

      razorpay:
        Boolean(razorpay),

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

      const dataUrl =
        await QRCode.toDataURL(
          uploadUrl,
          {
            width: 360,
            margin: 2
          }
        );

      res.json({

        uploadUrl,

        qr: dataUrl

      });

    } catch (error) {

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
        event => event.id > since
      )

    );

  }
);


// ======================================================
// UPLOAD
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

      job:
        currentJob

    });

  }
);


// ======================================================
// OPTIONS
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


    const pages =
      Math.max(
        1,
        Number(req.body.pages || 1)
      );


    const copies =
      Math.max(
        1,
        Number(req.body.copies || 1)
      );


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


    currentJob.status =
      "awaiting_payment";


    currentJob.paymentStatus =
      "unpaid";


    emit(
      "options_selected",
      {
        job:
          currentJob
      }
    );


    res.json({

      ok: true,

      job:
        currentJob

    });

  }
);


// ======================================================
// RAZORPAY CREATE ORDER
// ======================================================

app.post(
  "/create-order",
  async (req, res) => {

    try {

      if (!razorpay) {

        return res.status(500).json({

          error:
            "Razorpay is not configured on the server."

        });

      }


      const requestedAmount =
        Number(req.body.amount);


      if (
        !Number.isFinite(
          requestedAmount
        ) ||
        requestedAmount <= 0
      ) {

        return res.status(400).json({

          error:
            "Invalid payment amount."

        });

      }


      // --------------------------------------------------
      // Use the current server job when available.
      // --------------------------------------------------

      let amount =
        requestedAmount;


      if (
        currentJob &&
        Number(currentJob.amount) > 0
      ) {

        amount =
          Number(currentJob.amount);

      }


      // --------------------------------------------------
      // Amount in Razorpay is paise.
      // ₹8 = 800 paise.
      // --------------------------------------------------

      const amountInPaise =
        Math.round(
          amount * 100
        );


      const receipt =
        "AXM_" +
        Date.now();


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
              "AXM Printing",

            jobId:
              currentJob
                ? currentJob.id
                : "web",

            pages:
              currentJob
                ? String(currentJob.pages)
                : "",

            copies:
              currentJob
                ? String(currentJob.copies)
                : "",

            sides:
              currentJob
                ? String(currentJob.sides)
                : "",

            color:
              currentJob
                ? String(currentJob.color)
                : ""

          }

        });


      if (currentJob) {

        currentJob.razorpayOrderId =
          order.id;

        currentJob.paymentStatus =
          "order_created";

        currentJob.status =
          "payment_pending";

      }


      emit(
        "payment_order_created",
        {

          orderId:
            order.id,

          amount:
            amount,

          job:
            currentJob

        }
      );


      res.json({

        ok: true,

        key:
          RAZORPAY_KEY_ID,

        order:
          order

      });


    } catch (error) {

      console.error(
        "Razorpay order error:",
        error
      );


      res.status(500).json({

        error:
          error.error?.description ||
          error.message ||
          "Unable to create Razorpay order."

      });

    }

  }
);


// ======================================================
// RAZORPAY VERIFY PAYMENT
// ======================================================

app.post(
  "/verify-payment",
  async (req, res) => {

    try {

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

          success: false,

          error:
            "Incomplete Razorpay payment information."

        });

      }


      if (!RAZORPAY_KEY_SECRET) {

        return res.status(500).json({

          success: false,

          error:
            "Razorpay secret is not configured."

        });

      }


      // --------------------------------------------------
      // IMPORTANT:
      // Signature = HMAC_SHA256(order_id + "|" + payment_id)
      // --------------------------------------------------

      const generatedSignature =
        crypto
          .createHmac(
            "sha256",
            RAZORPAY_KEY_SECRET
          )
          .update(
            razorpay_order_id +
            "|" +
            razorpay_payment_id
          )
          .digest("hex");


      const signaturesMatch =
        crypto.timingSafeEqual(

          Buffer.from(
            generatedSignature,
            "utf8"
          ),

          Buffer.from(
            razorpay_signature,
            "utf8"
          )

        );


      if (!signaturesMatch) {

        console.error(
          "Razorpay signature verification failed."
        );


        if (currentJob) {

          currentJob.paymentStatus =
            "failed";

          currentJob.status =
            "payment_failed";

        }


        return res.status(400).json({

          success: false,

          error:
            "Payment verification failed."

        });

      }


      // --------------------------------------------------
      // PAYMENT VERIFIED
      // --------------------------------------------------

      if (currentJob) {

        currentJob.paymentStatus =
          "paid";

        currentJob.status =
          "print_ready";

        currentJob.paymentReference =
          razorpay_payment_id;

        currentJob.razorpayOrderId =
          razorpay_order_id;

        currentJob.paidAt =
          new Date().toISOString();

      }


      emit(
        "payment_verified",
        {

          paymentId:
            razorpay_payment_id,

          orderId:
            razorpay_order_id,

          job:
            currentJob

        }
      );


      res.json({

        success: true,

        paymentId:
          razorpay_payment_id,

        orderId:
          razorpay_order_id,

        job:
          currentJob

      });


    } catch (error) {

      console.error(
        "Payment verification error:",
        error
      );


      res.status(500).json({

        success: false,

        error:
          "Unable to verify payment."

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
      "TEST-" +
      Date.now();


    emit(
      "payment_verified",
      {
        job:
          currentJob
      }
    );


    res.json({

      ok: true,

      job:
        currentJob

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


    currentJob.status =
      "printing";


    emit(
      "printing_started",
      {
        job:
          currentJob
      }
    );


    // --------------------------------------------------
    // Temporary simulation.
    // Real Windows printer connection will be added later.
    // --------------------------------------------------

    setTimeout(
      () => {

        if (
          currentJob &&
          currentJob.id ===
            req.body.jobId
        ) {

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

      job:
        currentJob

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
        .send(
          "File not found"
        );

    }


    res.download(

      path.join(
        UPLOADS,
        currentJob.storedFile
      ),

      currentJob.filename

    );

  }
);


// ======================================================
// ERROR HANDLER
// ======================================================

app.use(
  (err, req, res, next) => {

    console.error(err);

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
      " AXM V2.2 SERVER IS RUNNING"
    );

    console.log(
      ` Port: ${PORT}`
    );

    console.log(
      ` Computer: http://localhost:${PORT}`
    );

    console.log(
      ` Razorpay: ${
        razorpay
          ? "CONFIGURED"
          : "NOT CONFIGURED"
      }`
    );

    console.log(
      "========================================"
    );

  }
);
