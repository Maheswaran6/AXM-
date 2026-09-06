const express = require("express");
const crypto = require("crypto");
const path = require("path");
const Razorpay = require("razorpay");

const app = express();

const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ----------------------------------------------------
// RAZORPAY CONFIGURATION
// ----------------------------------------------------

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

// ----------------------------------------------------
// STATIC FILES
// ----------------------------------------------------

app.use(express.static(__dirname));

// ----------------------------------------------------
// HOME
// ----------------------------------------------------

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

// ----------------------------------------------------
// RAZORPAY CONFIG CHECK
// ----------------------------------------------------

app.get("/api/payment-config", (req, res) => {
    res.json({
        configured: !!razorpay,
        key_id: RAZORPAY_KEY_ID || null
    });
});

// ----------------------------------------------------
// CREATE RAZORPAY ORDER
// ----------------------------------------------------

app.post("/api/create-order", async (req, res) => {

    try {

        if (!razorpay) {
            return res.status(500).json({
                success: false,
                message: "Razorpay is not configured on the server."
            });
        }

        const amount = Number(req.body.amount);

        if (!Number.isFinite(amount) || amount <= 0) {
            return res.status(400).json({
                success: false,
                message: "Invalid payment amount."
            });
        }

        // Convert rupees to paise
        const amountInPaise = Math.round(amount * 100);

        const options = {
            amount: amountInPaise,
            currency: "INR",
            receipt: `AXM_${Date.now()}`,
            notes: {
                project: "AXM Print Service"
            }
        };

        const order = await razorpay.orders.create(options);

        console.log("Razorpay order created:", order.id);

        return res.json({
            success: true,
            order
        });

    } catch (error) {

        console.error("Create order error:", error);

        return res.status(500).json({
            success: false,
            message: error.error?.description ||
                     error.message ||
                     "Unable to create Razorpay order."
        });
    }
});

// ----------------------------------------------------
// VERIFY PAYMENT
// ----------------------------------------------------

app.post("/api/verify-payment", (req, res) => {

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
                message: "Missing payment verification details."
            });
        }

        const body =
            razorpay_order_id +
            "|" +
            razorpay_payment_id;

        const expectedSignature =
            crypto
                .createHmac("sha256", RAZORPAY_KEY_SECRET)
                .update(body)
                .digest("hex");

        const isValid =
            expectedSignature === razorpay_signature;

        if (!isValid) {

            console.log("Payment signature verification FAILED");

            return res.status(400).json({
                success: false,
                message: "Payment verification failed."
            });
        }

        console.log("Payment verified successfully");
        console.log("Payment ID:", razorpay_payment_id);

        return res.json({
            success: true,
            message: "Payment verified successfully.",
            payment_id: razorpay_payment_id,
            order_id: razorpay_order_id
        });

    } catch (error) {

        console.error("Payment verification error:", error);

        return res.status(500).json({
            success: false,
            message: "Payment verification failed."
        });
    }
});

// ----------------------------------------------------
// TEST PAYMENT / DEVELOPMENT ONLY
// ----------------------------------------------------

app.post("/api/test-payment", (req, res) => {

    const amount = Number(req.body.amount);

    if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({
            success: false,
            message: "Invalid amount."
        });
    }

    return res.json({
        success: true,
        message: "Test payment successful.",
        amount
    });
});

// ----------------------------------------------------
// START SERVER
// ----------------------------------------------------

app.listen(PORT, "0.0.0.0", () => {

    console.log("==========================================");
    console.log("AXM V2.2 SERVER IS RUNNING");
    console.log("Port:", PORT);
    console.log("Razorpay:", razorpay ? "CONFIGURED" : "NOT CONFIGURED");
    console.log("==========================================");

});
