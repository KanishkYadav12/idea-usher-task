require("dotenv").config();
const jwt = require("jsonwebtoken");
const User = require("../models/user.model");
const ApiResponse = require("../utils/ApiResponse");
const redis = require("../config/redis");

const CACHE_TTL = {
  userProfile: 3600, // 1 hour
};

const getUserCacheKey = (userId) => `user:${userId}`;

const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN,
  });
};

// POST /api/auth/register
const register = async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "Name, email and password are all required",
      });
    }

    if (name.trim().length < 2) {
      return res.status(400).json({
        success: false,
        message: "Name must be at least 2 characters",
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        message: "Invalid email format",
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 6 characters",
      });
    }

    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: "An account with this email already exists",
      });
    }

    const user = await User.create({
      name: name.trim(),
      email: email.toLowerCase(),
      password,
    });

    const token = generateToken(user._id);

    res.status(201).json(
      new ApiResponse(
        201,
        {
          token,
          user: { id: user._id, name: user.name, email: user.email },
        },
        "User registered successfully",
      ),
    );
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/auth/login
const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        message: "Invalid email format",
      });
    }

    const user = await User.findOne({ email: email.toLowerCase() }).select(
      "+password",
    );
    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    const token = generateToken(user._id);

    // Invalidate user profile cache on login
    // so fresh data is always served after login
    try {
      await redis.del(getUserCacheKey(user._id));
    } catch (err) {
      // non-critical
    }

    res.status(200).json(
      new ApiResponse(
        200,
        {
          token,
          user: { id: user._id, name: user.name, email: user.email },
        },
        "Login successful",
      ),
    );
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/auth/me
const getMe = async (req, res) => {
  try {
    const userId = req.user._id;
    const cacheKey = getUserCacheKey(userId);

    // Check cache first
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return res
          .status(200)
          .json(new ApiResponse(200, cached, "Profile fetched (cached)"));
      }
    } catch (cacheErr) {
      console.error("Redis read error:", cacheErr.message);
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const userData = {
      id: user._id,
      name: user.name,
      email: user.email,
      createdAt: user.createdAt,
    };

    // Cache user profile for 1 hour
    try {
      await redis.set(cacheKey, userData, { ex: CACHE_TTL.userProfile });
    } catch (cacheErr) {
      console.error("Redis write error:", cacheErr.message);
    }

    res.status(200).json(new ApiResponse(200, userData, "Profile fetched"));
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = { register, login, getMe };
