const Task = require("../models/task.model");
const ApiResponse = require("../utils/ApiResponse");
const redis = require("../config/redis");

const STATUS_TRANSITIONS = {
  pending: "in-progress",
  "in-progress": "completed",
};

const getCacheKey = (userId, query) => {
  const { page, limit, status, startDate, endDate, search, sortBy, order } =
    query;
  return `tasks:${userId}:${page || 1}:${limit || 10}:${status || ""}:${startDate || ""}:${endDate || ""}:${search || ""}:${sortBy || ""}:${order || ""}`;
};

const invalidateUserCache = async (userId) => {
  try {
    // Delete all cache keys for this user using scan
    let cursor = 0;
    do {
      const result = await redis.scan(cursor, {
        match: `tasks:${userId}:*`,
        count: 100,
      });
      cursor = result[0];
      const keys = result[1];
      if (keys.length > 0) {
        await Promise.all(keys.map((key) => redis.del(key)));
      }
    } while (cursor !== 0);
  } catch (err) {
    console.error("Cache invalidation error:", err.message);
  }
};

// POST /api/tasks
const createTask = async (req, res) => {
  try {
    const { title, description, dueDate } = req.body;
    const userId = req.user._id;

    if (!title) {
      return res
        .status(400)
        .json({ success: false, message: "Title is required" });
    }

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    const duplicate = await Task.findOne({
      userId,
      title,
      createdAt: { $gte: startOfDay, $lte: endOfDay },
    });
    if (duplicate) {
      return res.status(400).json({
        success: false,
        message: "A task with this title already exists for today",
      });
    }

    const task = await Task.create({ title, description, dueDate, userId });
    await invalidateUserCache(userId);
    res.status(201).json(new ApiResponse(201, task, "Task created"));
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/tasks
const getTasks = async (req, res) => {
  try {
    const userId = req.user._id;
    const cacheKey = getCacheKey(userId, req.query);

    // Check cache first
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return res
          .status(200)
          .json(new ApiResponse(200, cached, "Tasks fetched (cached)"));
      }
    } catch (cacheErr) {
      console.error("Redis read error:", cacheErr.message);
    }

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || 10);
    const skip = (page - 1) * limit;

    const filter = { userId };

    if (req.query.status) filter.status = req.query.status;

    if (req.query.startDate || req.query.endDate) {
      filter.dueDate = {};
      if (req.query.startDate)
        filter.dueDate.$gte = new Date(req.query.startDate);
      if (req.query.endDate) filter.dueDate.$lte = new Date(req.query.endDate);
    }

    if (req.query.search) {
      filter.title = { $regex: req.query.search, $options: "i" };
    }

    const sortField = req.query.sortBy || "createdAt";
    const sortOrder = req.query.order === "asc" ? 1 : -1;

    const total = await Task.countDocuments(filter);
    const totalPages = Math.ceil(total / limit);

    if (total > 0 && page > totalPages) {
      return res.status(400).json({
        success: false,
        message: `Page ${page} does not exist. Total pages: ${totalPages}`,
      });
    }

    const tasks = await Task.find(filter)
      .sort({ [sortField]: sortOrder })
      .skip(skip)
      .limit(limit);

    const responseData = { total, page, limit, totalPages, data: tasks };

    // Store in cache with 60 second TTL
    try {
      await redis.set(cacheKey, responseData, { ex: 60 });
    } catch (cacheErr) {
      console.error("Redis write error:", cacheErr.message);
    }

    res.status(200).json(new ApiResponse(200, responseData, "Tasks fetched"));
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/tasks/:id
const getTaskById = async (req, res) => {
  try {
    const task = await Task.findOne({
      _id: req.params.id,
      userId: req.user._id,
    });
    if (!task)
      return res
        .status(404)
        .json({ success: false, message: "Task not found" });
    res.status(200).json(new ApiResponse(200, task, "Task fetched"));
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// PUT /api/tasks/:id
const updateTask = async (req, res) => {
  try {
    const task = await Task.findOne({
      _id: req.params.id,
      userId: req.user._id,
    });
    if (!task)
      return res
        .status(404)
        .json({ success: false, message: "Task not found" });

    const { title, description, dueDate, status } = req.body;

    if (status && status !== task.status) {
      const allowed = STATUS_TRANSITIONS[task.status];
      if (status !== allowed) {
        return res.status(400).json({
          success: false,
          message: `Invalid transition: ${task.status} → ${status}. Allowed: ${task.status} → ${allowed}`,
        });
      }
    }

    if (title) task.title = title;
    if (description) task.description = description;
    if (dueDate) task.dueDate = dueDate;
    if (status) task.status = status;

    await task.save();
    await invalidateUserCache(req.user._id);
    res.status(200).json(new ApiResponse(200, task, "Task updated"));
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// DELETE /api/tasks/:id
const deleteTask = async (req, res) => {
  try {
    const task = await Task.findOneAndDelete({
      _id: req.params.id,
      userId: req.user._id,
    });
    if (!task)
      return res
        .status(404)
        .json({ success: false, message: "Task not found" });
    await invalidateUserCache(req.user._id);
    res.status(200).json(new ApiResponse(200, null, "Task deleted"));
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = { createTask, getTasks, getTaskById, updateTask, deleteTask };
