const express = require("express");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const QRCode = require("qrcode");
const Razorpay = require("razorpay");

const app = express();

const PORT = process.env.PORT || 10000;

// ============================================================
// DIRECTORIES
// ============================================================

const DATA_DIR = path.join(__dirname, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(__dirname));

// ============================================================
// MULTER UPLOAD CONFIGURATION
// ============================================================

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, UPLOAD_DIR);
    },

    filename: function (req, file, cb) {
        const safeName = path
            .basename(file.originalname)
            .replace(/[^a-zA-Z0-9._-]/g, "_");

        const uniqueName =
            Date.now() +
            "_" +
            crypto.randomBytes(5).toString("hex") +
            "_" +
            safeName;

        cb(null, uniqueName);
    }
});

const upload = multer({
    storage: storage,

    limits: {
        fileSize: 25 * 1024 * 1024
    },

    fileFilter: function (req, file, cb) {

        const allowed = [
            "application/pdf",
            "image/jpeg",
            "image/png",
            "image/webp"
        ];

        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error("Only PDF, JPG, PNG and WEBP files are allowed."));
        }
    }
});

// ============================================================
// RAZORPAY
// ============================================================

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

// ============================================================
// APPLICATION STATE
// ============================================================

let machineSession = {
    token: null,
    createdAt: 0
};

let currentJob = null;

let eventId = 0;

const events = [];

// ============================================================
// EVENT SYSTEM
// ============================================================

function addEvent(data) {

    eventId++;

    const event = {
        id: eventId,
        time: Date.now(),
        ...data
    };

    events.push(event);

    // Keep only latest 100 events
    if (events.length > 100) {
        events.shift();
    }

    console.log("EVENT:", event);

    return event;
}

// ============================================================
// BASE URL
// ============================================================

function getBaseUrl(req) {

    const forwardedProto = req.headers["x-forwarded-proto"];

    const protocol =
        forwardedProto ||
        req.protocol ||
        "https";

    const host =
        req.headers["x-forwarded-host"] ||
        req.get("host");

    return `${protocol}://${host}`;
}

// ============================================================
// HOME
// ============================================================

app.get("/", function (req, res) {

    res.sendFile(
        path.join(__dirname, "index.html")
    );
});

// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/api/health", function (req, res) {

    res.json({
        success: true,
        status: "online",
        razorpay: !!razorpay,
        job: currentJob ? true : false,
        timestamp: Date.now()
    });
});

// ============================================================
// PAYMENT CONFIG
// ============================================================

app.get("/api/payment-config", function (req, res) {

    res.json({
        success: true,
        configured: !!razorpay,
        key_id: RAZORPAY_KEY_ID || null
    });
});

// ============================================================
// MACHINE QR
// ============================================================

app.get("/api/machine-qr", async function (req, res) {

    try {

        const token = crypto
            .randomBytes(24)
            .toString("hex");

        machineSession = {
            token: token,
            createdAt: Date.now()
        };

        const uploadUrl =
            getBaseUrl(req) +
            "/upload.html?token=" +
            encodeURIComponent(token);

        const qr = await QRCode.toDataURL(uploadUrl, {
            width: 350,
            margin: 2,
            errorCorrectionLevel: "M"
        });

        console.log("New machine QR generated");

        return res.json({
            success: true,
            qr: qr,
            uploadUrl: uploadUrl,
            token: token
        });

    } catch (error) {

        console.error("QR ERROR:", error);

        return res.status(500).json({
            success: false,
            error: "Unable to generate QR code."
        });
    }
});

// ============================================================
// GET CURRENT JOB
// ============================================================

app.get("/api/current-job", function (req, res) {

    return res.json({
        success: true,
        job: currentJob
    });
});

// ============================================================
// MOBILE DOCUMENT UPLOAD
// ============================================================

app.post(
    "/api/upload",
    upload.single("document"),
    function (req, res) {

        try {

            if (!req.file) {

                return res.status(400).json({
                    success: false,
                    error: "No document was uploaded."
                });
            }

            const token =
                req.query.token ||
                req.body.token ||
                req.headers["x-axm-token"];

            // ------------------------------------------------
            // If a QR token is supplied, validate it.
            // ------------------------------------------------

            if (token) {

                if (
                    !machineSession.token ||
                    token !== machineSession.token
                ) {

                    return res.status(403).json({
                        success: false,
                        error: "This AXM QR code is no longer valid. Generate a new QR code."
                    });
                }
            }

            // ------------------------------------------------
            // Create job
            // ------------------------------------------------

            currentJob = {

                id: crypto
                    .randomBytes(10)
                    .toString("hex"),

                filename: req.file.originalname,

                storedFile: req.file.filename,

                filepath: req.file.path,

                mimetype: req.file.mimetype,

                size: req.file.size,

                status: "RECEIVED",

                colour: "Black & White",

                sides: "Single Side",

                pages: 1,

                copies: 1,

                amount: 2,

                paymentStatus: "PENDING",

                createdAt: Date.now()
            };

            addEvent({
                type: "document_received",
                job: currentJob
            });

            console.log(
                "DOCUMENT RECEIVED:",
                req.file.originalname
            );

            return res.status(200).json({

                success: true,

                message:
                    "Document uploaded successfully to AXM.",

                job: currentJob
            });

        } catch (error) {

            console.error("UPLOAD ERROR:", error);

            return res.status(500).json({

                success: false,

                error:
                    error.message ||
                    "Document upload failed."
            });
        }
    }
);

// ============================================================
// EVENTS
// ============================================================

app.get("/api/events", function (req, res) {

    try {

        const since = Number(req.query.since || 0);

        const result = events.filter(function (event) {
            return event.id > since;
        });

        return res.json(result);

    } catch (error) {

        console.error("EVENT ERROR:", error);

        return res.status(500).json({
            success: false,
            error: "Unable to read events."
        });
    }
});

// ============================================================
// SAVE PRINT OPTIONS
// ============================================================

app.post("/api/options", function (req, res) {

    try {

        if (!currentJob) {

            return res.status(400).json({
                success: false,
                error: "No document has been received yet."
            });
        }

        const colour =
            req.body.colour ||
            req.body.color ||
            "Black & White";

        const sides =
            req.body.sides ||
            "Single Side";

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

        // ----------------------------------------------------
        // PRICE
        //
        // Black & White = ₹2 per page/copy
        // Colour       = ₹5 per page/copy
        //
        // Double Side is treated as pages printed on both
        // sides, so each physical sheet is charged accordingly.
        // ----------------------------------------------------

        let rate;

        if (
            colour.toLowerCase().includes("colour") ||
            colour.toLowerCase().includes("color")
        ) {
            rate = 5;
        } else {
            rate = 2;
        }

        let totalPages = pages * copies;

        let amount = totalPages * rate;

        currentJob.colour = colour;
        currentJob.sides = sides;
        currentJob.pages = pages;
        currentJob.copies = copies;
        currentJob.amount = amount;
        currentJob.status = "OPTIONS_SELECTED";
        currentJob.paymentStatus = "PENDING";

        addEvent({
            type: "options_selected",
            job: currentJob
        });

        console.log(
            "OPTIONS:",
            colour,
            sides,
            pages,
            copies,
            "AMOUNT:",
            amount
        );

        return res.json({

            success: true,

            message: "Print options saved.",

            job: currentJob,

            amount: amount
        });

    } catch (error) {

        console.error("OPTIONS ERROR:", error);

        return res.status(500).json({

            success: false,

            error:
                error.message ||
                "Unable to save print options."
        });
    }
});

// ============================================================
// CREATE RAZORPAY ORDER
// ============================================================

app.post("/api/create-order", async function (req, res) {

    try {

        if (!razorpay) {

            return res.status(500).json({

                success: false,

                error:
                    "Razorpay is not configured on the server."
            });
        }

        let amount;

        if (
            req.body &&
            req.body.amount !== undefined
        ) {

            amount = Number(req.body.amount);

        } else if (currentJob) {

            amount = Number(
                currentJob.amount
            );

        } else {

            amount = 0;
        }

        if (
            !Number.isFinite(amount) ||
            amount <= 0
        ) {

            return res.status(400).json({

                success: false,

                error:
                    "Invalid payment amount."
            });
        }

        const amountInPaise =
            Math.round(amount * 100);

        const receipt =
            "AXM_" +
            Date.now();

        const options = {

            amount: amountInPaise,

            currency: "INR",

            receipt: receipt,

            notes: {
                project: "AXM Print Service",

                job_id:
                    currentJob
                        ? currentJob.id
                        : "none"
            }
        };

        const order =
            await razorpay.orders.create(options);

        console.log(
            "RAZORPAY ORDER:",
            order.id
        );

        if (currentJob) {

            currentJob.razorpayOrderId =
                order.id;

            currentJob.status =
                "PAYMENT_STARTED";
        }

        return res.json({

            success: true,

            key_id:
                RAZORPAY_KEY_ID,

            order: order,

            amount: amount
        });

    } catch (error) {

        console.error(
            "RAZORPAY CREATE ORDER ERROR:",
            error
        );

        return res.status(500).json({

            success: false,

            error:
                error.error?.description ||
                error.message ||
                "Unable to create Razorpay order."
        });
    }
});

// ============================================================
// VERIFY RAZORPAY PAYMENT
// ============================================================

app.post(
    "/api/verify-payment",
    function (req, res) {

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
                        "Missing Razorpay payment details."
                });
            }

            if (!RAZORPAY_KEY_SECRET) {

                return res.status(500).json({

                    success: false,

                    error:
                        "Razorpay secret is not configured."
                });
            }

            const body =
                razorpay_order_id +
                "|" +
                razorpay_payment_id;

            const expectedSignature =
                crypto
                    .createHmac(
                        "sha256",
                        RAZORPAY_KEY_SECRET
                    )
                    .update(body)
                    .digest("hex");

            const valid =
                crypto.timingSafeEqual(
                    Buffer.from(expectedSignature),
                    Buffer.from(razorpay_signature)
                );

            if (!valid) {

                console.log(
                    "PAYMENT VERIFICATION FAILED"
                );

                return res.status(400).json({

                    success: false,

                    error:
                        "Payment verification failed."
                });
            }

            console.log(
                "PAYMENT VERIFIED:",
                razorpay_payment_id
            );

            if (currentJob) {

                currentJob.paymentStatus =
                    "PAID";

                currentJob.status =
                    "PAYMENT_SUCCESS";

                currentJob.razorpayPaymentId =
                    razorpay_payment_id;

                currentJob.razorpayOrderId =
                    razorpay_order_id;

                addEvent({

                    type: "payment_success",

                    job: currentJob
                });
            }

            return res.json({

                success: true,

                message:
                    "Payment verified successfully.",

                payment_id:
                    razorpay_payment_id,

                order_id:
                    razorpay_order_id,

                job: currentJob
            });

        } catch (error) {

            console.error(
                "PAYMENT VERIFY ERROR:",
                error
            );

            return res.status(500).json({

                success: false,

                error:
                    "Payment verification failed."
            });
        }
    }
);

// ============================================================
// TEST PAYMENT
// ============================================================

app.post("/api/test-payment", function (req, res) {

    try {

        let amount =
            Number(
                req.body.amount ||
                (currentJob
                    ? currentJob.amount
                    : 0)
            );

        if (
            !Number.isFinite(amount) ||
            amount <= 0
        ) {

            return res.status(400).json({

                success: false,

                error:
                    "Invalid amount."
            });
        }

        if (currentJob) {

            currentJob.paymentStatus =
                "PAID";

            currentJob.status =
                "PAYMENT_SUCCESS";

            currentJob.testPayment = true;

            addEvent({

                type: "payment_success",

                job: currentJob
            });
        }

        return res.json({

            success: true,

            message:
                "Test payment successful.",

            amount: amount,

            job: currentJob
        });

    } catch (error) {

        console.error(
            "TEST PAYMENT ERROR:",
            error
        );

        return res.status(500).json({

            success: false,

            error:
                "Test payment failed."
        });
    }
});

// ============================================================
// PRINT
// ============================================================

app.post("/api/print", function (req, res) {

    try {

        if (!currentJob) {

            return res.status(400).json({

                success: false,

                error:
                    "No print job available."
            });
        }

        if (
            currentJob.paymentStatus !==
            "PAID"
        ) {

            return res.status(403).json({

                success: false,

                error:
                    "Payment is required before printing."
            });
        }

        currentJob.status =
            "PRINTING";

        addEvent({

            type: "printing",

            job: currentJob
        });

        console.log(
            "PRINT JOB:",
            currentJob.filename
        );

        // ----------------------------------------------------
        // In the web prototype, we cannot directly control
        // the physical printer from the browser/server.
        // The print page can be opened for browser printing.
        // ----------------------------------------------------

        return res.json({

            success: true,

            message:
                "Print job is ready.",

            job: currentJob,

            printUrl:
                "/print.html"
        });

    } catch (error) {

        console.error(
            "PRINT ERROR:",
            error
        );

        return res.status(500).json({

            success: false,

            error:
                "Unable to start printing."
        });
    }
});

// ============================================================
// RESET MACHINE
// ============================================================

app.post("/api/reset", function (req, res) {

    currentJob = null;

    addEvent({
        type: "machine_reset"
    });

    return res.json({

        success: true,

        message:
            "AXM machine reset."
    });
});

// ============================================================
// UPLOAD ERROR HANDLER
// ============================================================

app.use(function (error, req, res, next) {

    console.error(
        "SERVER ERROR:",
        error
    );

    if (
        req.path === "/api/upload"
    ) {

        return res.status(400).json({

            success: false,

            error:
                error.message ||
                "Upload failed."
        });
    }

    return res.status(500).json({

        success: false,

        error:
            error.message ||
            "Server error."
    });
});

// ============================================================
// 404 API HANDLER
// ============================================================

app.use("/api", function (req, res) {

    return res.status(404).json({

        success: false,

        error:
            "API endpoint not found: " +
            req.method +
            " " +
            req.originalUrl
    });
});

// ============================================================
// START SERVER
// ============================================================

app.listen(
    PORT,
    "0.0.0.0",
    function () {

        console.log(
            "=========================================="
        );

        console.log(
            "AXM SERVER IS RUNNING"
        );

        console.log(
            "Port:",
            PORT
        );

        console.log(
            "Razorpay:",
            razorpay
                ? "CONFIGURED"
                : "NOT CONFIGURED"
        );

        console.log(
            "=========================================="
        );
    }
);
