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

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(__dirname));

// ============================================================
// UPLOAD
// ============================================================

const storage = multer.diskStorage({

    destination: function (req, file, cb) {
        cb(null, UPLOAD_DIR);
    },

    filename: function (req, file, cb) {

        const safeName =
            path.basename(file.originalname)
                .replace(/[^a-zA-Z0-9._-]/g, "_");

        const filename =
            Date.now() +
            "_" +
            crypto.randomBytes(6).toString("hex") +
            "_" +
            safeName;

        cb(null, filename);
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
            cb(
                new Error(
                    "Only PDF, JPG, PNG and WEBP files are allowed."
                )
            );
        }
    }
});

// ============================================================
// RAZORPAY
// ============================================================

const RAZORPAY_KEY_ID =
    process.env.RAZORPAY_KEY_ID;

const RAZORPAY_KEY_SECRET =
    process.env.RAZORPAY_KEY_SECRET;

let razorpay = null;

if (
    RAZORPAY_KEY_ID &&
    RAZORPAY_KEY_SECRET
) {

    razorpay = new Razorpay({

        key_id:
            RAZORPAY_KEY_ID,

        key_secret:
            RAZORPAY_KEY_SECRET
    });

    console.log("Razorpay: CONFIGURED");

} else {

    console.log("Razorpay: NOT CONFIGURED");
}

// ============================================================
// AXM STATE
// ============================================================

/*
IMPORTANT:

The previous version depended on one temporary machineSession.

This version stores active sessions in memory by token.

The QR token remains valid for 30 minutes.
*/

const sessions = new Map();

let currentJob = null;

let eventId = 0;

const events = [];

// ============================================================
// SESSION CLEANUP
// ============================================================

function cleanupSessions() {

    const now = Date.now();

    for (const [token, session] of sessions.entries()) {

        if (
            now - session.createdAt >
            30 * 60 * 1000
        ) {

            sessions.delete(token);
        }
    }
}

setInterval(
    cleanupSessions,
    60 * 1000
);

// ============================================================
// EVENTS
// ============================================================

function addEvent(data) {

    eventId++;

    const event = {

        id: eventId,

        time: Date.now(),

        ...data
    };

    events.push(event);

    if (events.length > 100) {
        events.shift();
    }

    console.log(
        "EVENT:",
        event.type || "unknown"
    );

    return event;
}

// ============================================================
// BASE URL
// ============================================================

function getBaseUrl(req) {

    const forwardedProto =
        req.headers["x-forwarded-proto"];

    const protocol =
        forwardedProto ||
        req.protocol ||
        "https";

    const forwardedHost =
        req.headers["x-forwarded-host"];

    const host =
        forwardedHost ||
        req.get("host");

    return `${protocol}://${host}`;
}

// ============================================================
// HOME
// ============================================================

app.get("/", function (req, res) {

    res.sendFile(
        path.join(
            __dirname,
            "index.html"
        )
    );
});

// ============================================================
// HEALTH
// ============================================================

app.get("/api/health", function (req, res) {

    res.json({

        success: true,

        status: "online",

        razorpay:
            !!razorpay,

        razorpayConfigured:
            !!razorpay,

        activeSessions:
            sessions.size,

        job:
            !!currentJob,

        timestamp:
            Date.now()
    });
});

// ============================================================
// PAYMENT CONFIG
// ============================================================

app.get(
    "/api/payment-config",
    function (req, res) {

        res.json({

            success: true,

            configured:
                !!razorpay,

            key_id:
                RAZORPAY_KEY_ID || null
        });
    }
);

// ============================================================
// CREATE MACHINE QR
// ============================================================

app.get(
    "/api/machine-qr",
    async function (req, res) {

        try {

            const token =
                crypto
                    .randomBytes(32)
                    .toString("hex");

            sessions.set(
                token,
                {
                    createdAt:
                        Date.now(),

                    used:
                        false
                }
            );

            const uploadUrl =
                getBaseUrl(req) +
                "/upload.html?token=" +
                encodeURIComponent(token);

            const qr =
                await QRCode.toDataURL(
                    uploadUrl,
                    {
                        width: 350,
                        margin: 2,
                        errorCorrectionLevel:
                            "M"
                    }
                );

            console.log(
                "NEW AXM SESSION:",
                token.substring(0, 12)
            );

            res.json({

                success: true,

                qr:

                    qr,

                uploadUrl:

                    uploadUrl,

                token:

                    token
            });

        } catch (error) {

            console.error(
                "QR ERROR:",
                error
            );

            res.status(500).json({

                success: false,

                error:
                    "Unable to generate QR code."
            });
        }
    }
);

// ============================================================
// CURRENT JOB
// ============================================================

app.get(
    "/api/current-job",
    function (req, res) {

        res.json({

            success: true,

            job:
                currentJob
        });
    }
);

// ============================================================
// IMPORTANT: PAYMENT.HTML USES /api/job
// ============================================================

app.get(
    "/api/job",
    function (req, res) {

        res.json({

            success: true,

            job:
                currentJob
        });
    }
);

// ============================================================
// MOBILE UPLOAD
// ============================================================

app.post(
    "/api/upload",
    upload.single("document"),
    function (req, res) {

        try {

            if (!req.file) {

                return res.status(400).json({

                    success: false,

                    error:
                        "No document was uploaded."
                });
            }

            const token =
                req.query.token ||
                req.body.token ||
                req.headers["x-axm-token"];

            // ------------------------------------------------
            // REQUIRE QR TOKEN
            // ------------------------------------------------

            if (!token) {

                fs.unlink(
                    req.file.path,
                    () => {}
                );

                return res.status(403).json({

                    success: false,

                    error:
                        "No active AXM session. Please scan a new QR code."
                });
            }

            // ------------------------------------------------
            // CHECK SESSION
            // ------------------------------------------------

            const session =
                sessions.get(token);

            if (!session) {

                fs.unlink(
                    req.file.path,
                    () => {}
                );

                console.log(
                    "INVALID AXM TOKEN:",
                    token.substring(0, 12)
                );

                return res.status(403).json({

                    success: false,

                    error:
                        "No active AXM session. Please scan a new QR code."
                });
            }

            // ------------------------------------------------
            // SESSION EXPIRED
            // ------------------------------------------------

            if (
                Date.now() -
                session.createdAt >
                30 * 60 * 1000
            ) {

                sessions.delete(token);

                fs.unlink(
                    req.file.path,
                    () => {}
                );

                return res.status(403).json({

                    success: false,

                    error:
                        "AXM QR code expired. Please generate a new QR code."
                });
            }

            // ------------------------------------------------
            // CREATE JOB
            // ------------------------------------------------

            currentJob = {

                id:
                    crypto
                        .randomBytes(12)
                        .toString("hex"),

                filename:
                    req.file.originalname,

                storedFile:
                    req.file.filename,

                filepath:
                    req.file.path,

                mimetype:
                    req.file.mimetype,

                size:
                    req.file.size,

                status:
                    "RECEIVED",

                colour:
                    "Black & White",

                sides:
                    "Single Side",

                pages:
                    1,

                copies:
                    1,

                amount:
                    2,

                paymentStatus:
                    "PENDING",

                sessionToken:
                    token,

                createdAt:
                    Date.now()
            };

            // ------------------------------------------------
            // MARK SESSION AS USED
            // ------------------------------------------------

            session.used = true;

            session.jobId =
                currentJob.id;

            // ------------------------------------------------
            // EVENT
            // ------------------------------------------------

            addEvent({

                type:
                    "document_received",

                job:
                    currentJob
            });

            console.log(
                "================================"
            );

            console.log(
                "DOCUMENT RECEIVED"
            );

            console.log(
                "FILE:",
                currentJob.filename
            );

            console.log(
                "JOB:",
                currentJob.id
            );

            console.log(
                "================================"
            );

            return res.status(200).json({

                success: true,

                message:
                    "Document uploaded successfully to AXM.",

                job:
                    currentJob
            });

        } catch (error) {

            console.error(
                "UPLOAD ERROR:",
                error
            );

            if (req.file) {

                fs.unlink(
                    req.file.path,
                    () => {}
                );
            }

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

app.get(
    "/api/events",
    function (req, res) {

        const since =
            Number(
                req.query.since || 0
            );

        const result =
            events.filter(
                event =>
                    event.id > since
            );

        res.json(result);
    }
);

// ============================================================
// SAVE PRINT OPTIONS
// ============================================================

app.post(
    "/api/options",
    function (req, res) {

        try {

            if (!currentJob) {

                return res.status(400).json({

                    success: false,

                    error:
                        "No document has been received yet."
                });
            }

            let colour =
                req.body.colour ||
                req.body.color ||
                "Black & White";

            let sides =
                req.body.sides ||
                "Single Side";

            let pages =
                Number(
                    req.body.pages || 1
                );

            let copies =
                Number(
                    req.body.copies || 1
                );

            if (
                !Number.isFinite(pages) ||
                pages < 1
            ) {
                pages = 1;
            }

            if (
                !Number.isFinite(copies) ||
                copies < 1
            ) {
                copies = 1;
            }

            pages =
                Math.floor(pages);

            copies =
                Math.floor(copies);

            // ------------------------------------------------
            // PRICE
            // ------------------------------------------------

            let rate = 2;

            if (
                String(colour)
                    .toLowerCase()
                    .includes("colour") ||
                String(colour)
                    .toLowerCase()
                    .includes("color")
            ) {

                rate = 5;
            }

            const amount =
                pages *
                copies *
                rate;

            // ------------------------------------------------
            // UPDATE JOB
            // ------------------------------------------------

            currentJob.colour =
                colour;

            currentJob.sides =
                sides;

            currentJob.pages =
                pages;

            currentJob.copies =
                copies;

            currentJob.amount =
                amount;

            currentJob.status =
                "OPTIONS_SELECTED";

            currentJob.paymentStatus =
                "PENDING";

            addEvent({

                type:
                    "options_selected",

                job:
                    currentJob
            });

            console.log(
                "OPTIONS SAVED:",
                {
                    colour,
                    sides,
                    pages,
                    copies,
                    amount
                }
            );

            return res.json({

                success: true,

                message:
                    "Print options saved.",

                job:
                    currentJob,

                amount:
                    amount
            });

        } catch (error) {

            console.error(
                "OPTIONS ERROR:",
                error
            );

            return res.status(500).json({

                success: false,

                error:
                    "Unable to save print options."
            });
        }
    }
);

// ============================================================
// CREATE RAZORPAY ORDER
// ============================================================

app.post(
    "/api/create-order",
    async function (req, res) {

        try {

            if (!razorpay) {

                return res.status(500).json({

                    success: false,

                    error:
                        "Razorpay is not configured on the server."
                });
            }

            if (!currentJob) {

                return res.status(400).json({

                    success: false,

                    error:
                        "No active print job."
                });
            }

            const amount =
                Number(
                    currentJob.amount
                );

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

            const order =
                await razorpay.orders.create({

                    amount:
                        Math.round(
                            amount * 100
                        ),

                    currency:
                        "INR",

                    receipt:
                        "AXM_" +
                        Date.now(),

                    notes: {

                        project:
                            "AXM Print Service",

                        job_id:
                            currentJob.id
                    }
                });

            currentJob.razorpayOrderId =
                order.id;

            currentJob.status =
                "PAYMENT_STARTED";

            console.log(
                "RAZORPAY ORDER:",
                order.id
            );

            return res.json({

                success: true,

                key_id:
                    RAZORPAY_KEY_ID,

                order:
                    order,

                orderId:
                    order.id,

                amount:
                    order.amount,

                currency:
                    order.currency
            });

        } catch (error) {

            console.error(
                "CREATE ORDER ERROR:",
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
    }
);

// ============================================================
// VERIFY PAYMENT
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

            // ------------------------------------------------
            // CHECK ORDER BELONGS TO CURRENT JOB
            // ------------------------------------------------

            if (
                currentJob &&
                currentJob.razorpayOrderId &&
                currentJob.razorpayOrderId !==
                    razorpay_order_id
            ) {

                return res.status(400).json({

                    success: false,

                    error:
                        "Payment order does not match the current AXM job."
                });
            }

            const body =
                razorpay_order_id +
                "|" +
                razorpay_payment_id;

            const expected =
                crypto
                    .createHmac(
                        "sha256",
                        RAZORPAY_KEY_SECRET
                    )
                    .update(body)
                    .digest("hex");

            const valid =
                expected ===
                razorpay_signature;

            if (!valid) {

                return res.status(400).json({

                    success: false,

                    error:
                        "Payment verification failed."
                });
            }

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

                    type:
                        "payment_success",

                    job:
                        currentJob
                });
            }

            console.log(
                "PAYMENT VERIFIED:",
                razorpay_payment_id
            );

            return res.json({

                success: true,

                message:
                    "Payment verified successfully.",

                payment_id:
                    razorpay_payment_id,

                order_id:
                    razorpay_order_id,

                job:
                    currentJob
            });

        } catch (error) {

            console.error(
                "VERIFY PAYMENT ERROR:",
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

app.post(
    "/api/test-payment",
    function (req, res) {

        try {

            if (!currentJob) {

                return res.status(400).json({

                    success: false,

                    error:
                        "No active print job."
                });
            }

            currentJob.paymentStatus =
                "PAID";

            currentJob.status =
                "PAYMENT_SUCCESS";

            currentJob.testPayment =
                true;

            addEvent({

                type:
                    "payment_success",

                job:
                    currentJob
            });

            return res.json({

                success: true,

                message:
                    "Test payment successful.",

                amount:
                    currentJob.amount,

                job:
                    currentJob
            });

        } catch (error) {

            return res.status(500).json({

                success: false,

                error:
                    "Test payment failed."
            });
        }
    }
);

// ============================================================
// PRINT
// ============================================================

app.post(
    "/api/print",
    function (req, res) {

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

                type:
                    "printing",

                job:
                    currentJob
            });

            return res.json({

                success: true,

                message:
                    "Print job is ready.",

                job:
                    currentJob,

                printUrl:
                    "/print.html"
            });

        } catch (error) {

            return res.status(500).json({

                success: false,

                error:
                    "Unable to start printing."
            });
        }
    }
);

// ============================================================
// RESET
// ============================================================

app.post(
    "/api/reset",
    function (req, res) {

        currentJob =
            null;

        // Remove old sessions

        sessions.clear();

        addEvent({

            type:
                "machine_reset"
        });

        return res.json({

            success: true,

            message:
                "AXM machine reset."
        });
    }
);

// ============================================================
// API 404
// ============================================================

app.use(
    "/api",
    function (req, res) {

        res.status(404).json({

            success: false,

            error:
                "API endpoint not found: " +
                req.method +
                " " +
                req.originalUrl
        });
    }
);

// ============================================================
// GENERAL ERROR HANDLER
// ============================================================

app.use(
    function (error, req, res, next) {

        console.error(
            "SERVER ERROR:",
            error
        );

        if (
            req.path ===
            "/api/upload"
        ) {

            return res.status(400).json({

                success: false,

                error:
                    error.message ||
                    "Upload failed."
            });
        }

        res.status(500).json({

            success: false,

            error:
                error.message ||
                "Server error."
        });
    }
);

// ============================================================
// START
// ============================================================

app.listen(
    PORT,
    "0.0.0.0",
    function () {

        console.log(
            "=========================================="
        );

        console.log(
            "AXM V2.2 SERVER RUNNING"
        );

        console.log(
            "PORT:",
            PORT
        );

        console.log(
            "RAZORPAY:",
            razorpay
                ? "CONFIGURED"
                : "NOT CONFIGURED"
        );

        console.log(
            "=========================================="
        );
    }
);
