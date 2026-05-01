const express = require("express");
const cors = require("cors");
const limiter = require("./middleware/rateLimiter");
const errorHandler = require("./middleware/error.middleware");
const authRoutes = require("./routes/auth.routes");
const taskRoutes = require("./routes/task.routes");

const app = express();

app.use(cors());
app.use(express.json());
app.use(limiter);

app.use("/api/auth", authRoutes);
app.use("/api/tasks", taskRoutes);

// Health check
app.get("/", (req, res) => res.json({ message: "API is running" }));

// 404 handler
app.use((req, res, next) => {
  res.status(404).json({ success: false, message: "Route not found" });
});

// Centralized error handler — must be last
app.use((err, req, res, next) => {
  errorHandler(err, req, res, next);
});

module.exports = app;
