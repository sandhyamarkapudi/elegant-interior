require("dotenv").config();

const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
const bcrypt = require("bcrypt");
const path = require("path");

const app = express();

const allowedOrigins = (process.env.FRONTEND_URL || "").split(",").map((origin) => origin.trim()).filter(Boolean);
app.use(cors({
    origin: allowedOrigins.length ? allowedOrigins : true,
    credentials: true
}));
app.use(express.json({ limit: "1mb" }));

// MySQL Database Connection
const db = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Serve your HTML files
app.use(express.static(__dirname));
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "elegant interior.html"));
});

app.get("/test", (req, res) => {
    res.json({ success: true, message: "Server is working!" });
});

app.get("/health", async (req, res) => {
    try {
        await db.query("SELECT 1");
        res.json({ success: true, database: "connected" });
    } catch (error) {
        console.error("Health check database error:", error.message);
        res.status(503).json({ success: false, database: "unavailable" });
    }
});

function clean(value) {
    return typeof value === "string" ? value.trim() : "";
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

app.post("/register", async (req, res) => {
    const fullName = clean(req.body.fullName);
    const email = clean(req.body.email).toLowerCase();
    const password = typeof req.body.password === "string" ? req.body.password : "";

    if (!fullName || !email || !password || !isValidEmail(email)) {
        return res.status(400).json({
            success: false,
            message: "A valid full name, email, and password are required."
        });
    }

    if (password.length < 6) {
        return res.status(400).json({ success: false, message: "Password must be at least 6 characters." });
    }

    try {
        const passwordHash = await bcrypt.hash(password, 12);
        const [result] = await db.execute(
            "INSERT INTO users (full_name, email, password) VALUES (?, ?, ?)",
            [fullName, email, passwordHash]
        );
        res.status(201).json({ success: true, message: "Registration successful!", userId: result.insertId, fullName, email });
    } catch (error) {
        if (error.code === "ER_DUP_ENTRY") {
            return res.status(409).json({ success: false, message: "An account with this email already exists." });
        }
        console.error("Registration error:", error.message);
        res.status(500).json({ success: false, message: "Registration failed. Check the database connection." });
    }
});

app.post("/login", async (req, res) => {
    const email = clean(req.body.email).toLowerCase();
    const password = typeof req.body.password === "string" ? req.body.password : "";

    if (!email || !password || !isValidEmail(email)) {
        return res.status(400).json({ success: false, message: "A valid email and password are required." });
    }

    try {
        const [rows] = await db.execute("SELECT id, full_name, email, password FROM users WHERE email = ? LIMIT 1", [email]);
        if (!rows.length || !(await bcrypt.compare(password, rows[0].password))) {
            return res.status(401).json({ success: false, message: "Invalid email or password." });
        }
        res.json({ success: true, message: "Login successful!", user: { id: rows[0].id, fullName: rows[0].full_name, email: rows[0].email } });
    } catch (error) {
        console.error("Login error:", error.message);
        res.status(500).json({ success: false, message: "Login failed. Check the database connection." });
    }
});

app.post("/subscribe", async (req, res) => {
    const email = clean(req.body.email).toLowerCase();
    if (!email || !isValidEmail(email)) {
        return res.status(400).json({ success: false, message: "A valid email is required." });
    }
    try {
        await db.execute("INSERT INTO newsletter_subscribers (email) VALUES (?)", [email]);
        res.status(201).json({ success: true, message: "Subscription successful!" });
    } catch (error) {
        if (error.code === "ER_DUP_ENTRY") {
            return res.status(409).json({ success: false, message: "This email is already subscribed." });
        }
        console.error("Subscription error:", error.message);
        res.status(500).json({ success: false, message: "Subscription failed. Check the database connection." });
    }
});

app.post("/orders", async (req, res) => {
    const order = req.body;
    const requiredFields = ["email", "firstName", "lastName", "address", "city", "postalCode", "phone", "paymentMethod", "items", "subtotal", "discount", "tax", "shipping", "total"];
    const missingField = requiredFields.find((field) => order[field] === undefined || order[field] === null || order[field] === "");
    const numericFields = ["subtotal", "discount", "tax", "shipping", "total"];
    const hasInvalidAmount = numericFields.some((field) => !Number.isFinite(Number(order[field])) || Number(order[field]) < 0);
    const validPaymentMethods = ["card", "wallet", "paypal", "cod"];

    if (missingField || !isValidEmail(clean(order.email)) || !Array.isArray(order.items) || !order.items.length || hasInvalidAmount || !validPaymentMethods.includes(order.paymentMethod)) {
        return res.status(400).json({ success: false, message: "All shipping and order details are required." });
    }

    try {
        const orderNumber = `ELG-${Date.now().toString().slice(-8)}`;
        const [result] = await db.execute(
            `INSERT INTO orders
            (order_number, email, first_name, last_name, address, city, postal_code, phone, payment_method, items, subtotal, discount, tax, shipping, total)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [orderNumber, clean(order.email).toLowerCase(), clean(order.firstName), clean(order.lastName), clean(order.address), clean(order.city), clean(order.postalCode), clean(order.phone), clean(order.paymentMethod), JSON.stringify(order.items), Number(order.subtotal), Number(order.discount), Number(order.tax), Number(order.shipping), Number(order.total)]
        );
        res.status(201).json({ success: true, message: "Order placed successfully!", orderId: orderNumber, databaseId: result.insertId });
    } catch (error) {
        console.error("Order error:", error.message);
        res.status(500).json({ success: false, message: "Order could not be saved. Check the database connection." });
    }
});

app.get("/orders/:orderNumber", async (req, res) => {
    const orderNumber = clean(req.params.orderNumber);
    if (!orderNumber) {
        return res.status(400).json({ success: false, message: "An order number is required." });
    }
    try {
        const [rows] = await db.execute("SELECT order_number, status, created_at FROM orders WHERE order_number = ? LIMIT 1", [orderNumber]);
        if (!rows.length) {
            return res.status(404).json({ success: false, message: "Order not found." });
        }
        res.json({ success: true, order: rows[0] });
    } catch (error) {
        console.error("Order tracking error:", error.message);
        res.status(500).json({ success: false, message: "Order tracking is temporarily unavailable." });
    }
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
});