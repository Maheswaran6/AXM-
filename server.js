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
// FILE UPLOAD
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

        key_id: RAZORPAY_KEY_ID,

        key_secret: RAZORPAY_KEY_SECRET
    });

    console.log("Razorpay: CONFIGURED");

} else {

    console.log("Razorpay: NOT CONFIGURED");
}

// ============================================================
// AXM SESSION
// ============================================================

let machineSession = {
    token: null,
    createdAt: 0
};

let currentJob = null;

let eventCounter = 0;

const events = [];

// ============================================================
// EVENT
// ============================================================

function addEvent(data) {

    eventCounter++;

    const event = {

        id: eventCounter,

        time: Date.now(),

        ...data
    };

    events.push(event);

    if (events.length > 100) {
        events.shift();
    }

    console.log("EVENT:", event.type);

    return event;
}

// ============================================================
// BASE URL
// ============================================================

function getBaseUrl(req) {

    let protocol =
        req.headers["x-forwarded-proto"] ||
        req.protocol ||
        "https";

    if (protocol.includes(",")) {
        protocol = protocol.split(",")[0].trim();
    }

    const host =
        req.headers["x-forwarded-host"] ||
        req.get("host");

    return protocol + "://" + host;
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
// HEALTH
// ============================================================

app.get("/api/health", function (req, res) {

    res.json({

        success: true,

        status: "online",

        razorpay: !!razorpay,

        razorpayConfigured: !!razorpay,

        sessionActive:
            !!machineSession.token,

        job:
            !!currentJob,

        timestamp: Date.now()
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

            machineSession = {

                token: token,

                createdAt: Date.now()
            };

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
                        errorCorrectionLevel: "M"
                    }
                );

            console.log(
                "AXM SESSION CREATED:",
                token.substring(0, 8) + "..."
            );

            res.json({

                success: true,

                qr: qr,

                uploadUrl: uploadUrl
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
// CHECK SESSION
// ============================================================

app.get(
    "/api/session",
    function (req, res) {

        res.json({

            success: true,

            active:
                !!machineSession.token,

            createdAt:
                machineSession.createdAt || null
        });
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

            job: currentJob
        });
    }
);

// ============================================================
// JOB
// ============================================================

app.get(
    "/api/job",
    function (req, res) {

        res.json({

            success: true,

            job: currentJob
        });
    }
);

// ============================================================
// UPLOAD DOCUMENT
// ============================================================

app.post(
    "/api/upload",
    upload.single("document"),
    function (req, res) {

        try {

            // ------------------------------------------------
            // FILE CHECK
            // ------------------------------------------------

            if (!req.file) {

                return res.status(400).json({

                    success: false,

                    error:
                        "No document was uploaded."
                });
            }

            // ------------------------------------------------
            // TOKEN
            // ------------------------------------------------

            const token =
                req.body.token ||
                req.query.token ||
                req.headers["x-axm-token"];

            console.log(
                "UPLOAD REQUEST"
            );

            console.log(
                "Token received:",
                token
                    ? token.substring(0, 8) + "..."
                    : "NONE"
            );

            console.log(
                "Session active:",
                !!machineSession.token
            );

            // ------------------------------------------------
            // SESSION VALIDATION
            // ------------------------------------------------

            if (!machineSession.token) {

                fs.unlink(
                    req.file.path,
                    function () {}
                );

                return res.status(403).json({

                    success: false,

                    error:
                        "No active AXM session. Please scan a new QR code."
                });
            }

            if (
                !token ||
                token !== machineSession.token
            ) {

                fs.unlink(
                    req.file.path,
                    function () {}
                );

                return res.status(403).json({

                    success: false,

                    error:
                        "This AXM QR code is invalid or expired. Please scan the current QR code again."
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

                createdAt:
                    Date.now()
            };

            addEvent({

                type:
                    "document_received",

                job:
                    currentJob
            });

            console.log(
                "DOCUMENT RECEIVED:",
                currentJob.filename
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
            Number(req.query.since || 0);

        const result =
            events.filter(function (event) {

                return event.id > since;

            });

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

            const colour =
                req.body.colour ||
                req.body.color ||
                "Black & White";

            const sides =
                req.body.sides ||
                "Single Side";

            let pages =
                Number(req.body.pages);

            let copies =
                Number(req.body.copies);

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

            let rate = 2;

            if (
                colour
                    .toLowerCase()
                    .includes("colour") ||
                colour
                    .toLowerCase()
                    .includes("color")
            ) {

                rate = 5;
            }

            const amount =
                pages *
                copies *
                rate;

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
                colour,
                sides,
                pages,
                copies,
                amount
            );

            res.json({

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

            res.status(500).json({

                success: false,

                error:
                    error.message
            });
        }
    }
);

// ============================================================
// CREATE RAZORPAY ORDER
// ============================================================

app.post(
    "/api/payment/create-order",
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
                Number(currentJob.amount);

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

            res.json({

                success: true,

                keyId:
                    RAZORPAY_KEY_ID,

                key_id:
                    RAZORPAY_KEY_ID,

                orderId:
                    order.id,

                order_id:
                    order.id,

                amount:
                    order.amount,

                currency:
                    order.currency,

                order:
                    order
            });

        } catch (error) {

            console.error(
                "RAZORPAY ORDER ERROR:",
                error
            );

            res.status(500).json({

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
// ALSO SUPPORT OLD PAYMENT URL
// ============================================================

app.post(
    "/api/create-order",
    async function (req, res) {

        req.url =
            "/api/payment/create-order";

        // Directly reproduce order creation
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
                    req.body.amount ||
                    currentJob.amount
                );

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

            res.json({

                success: true,

                keyId:
                    RAZORPAY_KEY_ID,

                key_id:
                    RAZORPAY_KEY_ID,

                orderId:
                    order.id,

                amount:
                    order.amount,

                currency:
                    order.currency,

                order:
                    order
            });

        } catch (error) {

            console.error(error);

            res.status(500).json({

                success: false,

                error:
                    error.error?.description ||
                    error.message
            });
        }
    }
);

// ============================================================
// VERIFY PAYMENT
// ============================================================

app.post(
    "/api/payment/verify",
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

            const expected =
                crypto
                    .createHmac(
                        "sha256",
                        RAZORPAY_KEY_SECRET
                    )
                    .update(body)
                    .digest("hex");

            if (
                expected.length !==
                razorpay_signature.length ||
                !crypto.timingSafeEqual(
                    Buffer.from(expected),
                    Buffer.from(
                        razorpay_signature
                    )
                )
            ) {

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

                currentJob.razorpayOrderId =
                    razorpay_order_id;

                currentJob.razorpayPaymentId =
                    razorpay_payment_id;

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

            res.json({

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
                "VERIFY ERROR:",
                error
            );

            res.status(500).json({

                success: false,

                error:
                    "Payment verification failed."
            });
        }
    }
);

// ============================================================
// OLD PAYMENT VERIFY URL
// ============================================================

app.post(
    "/api/verify-payment",
    function (req, res) {

        req.url =
            "/api/payment/verify";

        try {

            const {
                razorpay_order_id,
                razorpay_payment_id,
                razorpay_signature
            } = req.body;

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

            if (
                expected !==
                razorpay_signature
            ) {

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
            }

            res.json({

                success: true,

                message:
                    "Payment verified successfully.",

                job:
                    currentJob
            });

        } catch (error) {

            res.status(500).json({

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
    "/api/payment/test-success",
    function (req, res) {

        if (!currentJob) {

            return res.status(400).json({

                success: false,

                error:
                    "No active job."
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

        res.json({

            success: true,

            message:
                "Test payment successful.",

            job:
                currentJob
        });
    }
);

// ============================================================
// OLD TEST PAYMENT
// ============================================================

app.post(
    "/api/test-payment",
    function (req, res) {

        if (!currentJob) {

            return res.status(400).json({

                success: false,

                error:
                    "No active job."
            });
        }

        currentJob.paymentStatus =
            "PAID";

        currentJob.status =
            "PAYMENT_SUCCESS";

        currentJob.testPayment =
            true;

        res.json({

            success: true,

            message:
                "Test payment successful.",

            amount:
                currentJob.amount,

            job:
                currentJob
        });
    }
);

// ============================================================
// START PRINT
// ============================================================

app.post(
    "/api/print/start",
    function (req, res) {

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

        console.log(
            "PRINT STARTED:",
            currentJob.filename
        );

        res.json({

            success: true,

            message:
                "Printing started.",

            job:
                currentJob,

            printUrl:
                "/print.html"
        });
    }
);

// ============================================================
// OLD PRINT URL
// ============================================================

app.post(
    "/api/print",
    function (req, res) {

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

        res.json({

            success: true,

            message:
                "Printing started.",

            job:
                currentJob,

            printUrl:
                "/print.html"
        });
    }
);

// ============================================================
// RESET
// ============================================================

app.post(
    "/api/reset",
    function (req, res) {

        currentJob = null;

        machineSession = {

            token: null,

            createdAt: 0
        };

        addEvent({

            type:
                "machine_reset"
        });

        res.json({

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
// ERROR HANDLER
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
