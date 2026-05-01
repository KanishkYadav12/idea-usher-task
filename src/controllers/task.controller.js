const mongoose = require("mongoose");
const Task = require("../models/task.model");
const ApiResponse = require("../utils/ApiResponse");
const redis = require("../config/redis");

const STATUS_TRANSITIONS = {
  pending: "in-progress",
  "in-progress": "completed",
};

const VALID_STATUSES = ["pending", "in-progress", "completed"];
const VALID_SORT_FIELDS = [
  "createdAt",
  "updatedAt",
  "dueDate",
  "title",
  "status",
];

const CACHE_TTL = {
  taskList: 300, // 5 minutes
  taskById: 600, // 10 minutes
};

// Cache key generators
const getCacheKey = (userId, query) => {
  const { page, limit, status, startDate, endDate, search, sortBy, order } =
    query;
  return `tasks:${userId}:${page || 1}:${limit || 10}:${status || ""}:${startDate || ""}:${endDate || ""}:${search || ""}:${sortBy || ""}:${order || ""}`;
};

const getTaskCacheKey = (taskId) => `task:${taskId}`;
const getUserRegistryKey = (userId) => `registry:${userId}`;

// Register cache key in user's registry for later invalidation
const registerCacheKey = async (userId, key, ttl) => {
  try {
    const registryKey = getUserRegistryKey(userId);
    await redis.sadd(registryKey, key);
    await redis.expire(registryKey, ttl + 60);
  } catch (err) {
    // non-critical, silently fail
  }
};

// Proper invalidation — delete all registered keys for this user instantly
const invalidateUserCache = async (userId) => {
  try {
    const registryKey = getUserRegistryKey(userId);
    const keys = await redis.smembers(registryKey);
    if (keys && keys.length > 0) {
      await Promise.all(keys.map((key) => redis.del(key)));
      await redis.del(registryKey);
    }
  } catch (err) {
    console.error("Cache invalidation error:", err.message);
  }
};

// POST /api/tasks
const createTask = async (req, res) => {
  try {
    const { title, description, dueDate } = req.body;
    const userId = req.user._id;

    // Required field
    if (!title || title.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: "Task title is required",
      });
    }

    // Title length
    if (title.trim().length > 100) {
      return res.status(400).json({
        success: false,
        message: "Title cannot exceed 100 characters",
      });
    }

    // Due date validation
    if (dueDate) {
      const parsedDate = new Date(dueDate);
      if (isNaN(parsedDate.getTime())) {
        return res.status(400).json({
          success: false,
          message: "Invalid due date format. Use YYYY-MM-DD",
        });
      }
    }

    // Duplicate title check — same user, same day
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    const duplicate = await Task.findOne({
      userId,
      title: title.trim(),
      createdAt: { $gte: startOfDay, $lte: endOfDay },
    }).maxTimeMS(5000);

    if (duplicate) {
      return res.status(409).json({
        success: false,
        message: `Task "${title.trim()}" already exists for today. Use a different title or update the existing task.`,
      });
    }

    const task = await Task.create({
      title: title.trim(),
      description: description ? description.trim() : "",
      dueDate,
      userId,
    });

    // Invalidate list cache so user sees new task immediately
    await invalidateUserCache(userId);

    res
      .status(201)
      .json(new ApiResponse(201, task, "Task created successfully"));
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/tasks
const getTasks = async (req, res) => {
  try {
    const userId = req.user._id;

    // Validate status filter
    if (req.query.status && !VALID_STATUSES.includes(req.query.status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}`,
      });
    }

    // Validate date formats
    if (req.query.startDate && isNaN(new Date(req.query.startDate).getTime())) {
      return res.status(400).json({
        success: false,
        message: "Invalid startDate format. Use YYYY-MM-DD",
      });
    }

    if (req.query.endDate && isNaN(new Date(req.query.endDate).getTime())) {
      return res.status(400).json({
        success: false,
        message: "Invalid endDate format. Use YYYY-MM-DD",
      });
    }

    // Validate date range
    if (req.query.startDate && req.query.endDate) {
      if (new Date(req.query.startDate) > new Date(req.query.endDate)) {
        return res.status(400).json({
          success: false,
          message: "startDate cannot be after endDate",
        });
      }
    }

    // Validate sortBy field
    if (req.query.sortBy && !VALID_SORT_FIELDS.includes(req.query.sortBy)) {
      return res.status(400).json({
        success: false,
        message: `Invalid sortBy. Must be one of: ${VALID_SORT_FIELDS.join(", ")}`,
      });
    }

    // Validate order
    if (req.query.order && !["asc", "desc"].includes(req.query.order)) {
      return res.status(400).json({
        success: false,
        message: "Invalid order. Must be asc or desc",
      });
    }

    // Validate pagination
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;

    if (page < 1) {
      return res.status(400).json({
        success: false,
        message: "Page must be greater than 0",
      });
    }

    if (limit < 1 || limit > 100) {
      return res.status(400).json({
        success: false,
        message: "Limit must be between 1 and 100",
      });
    }

    // Check cache first
    const cacheKey = getCacheKey(userId, req.query);
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
      filter.title = { $regex: req.query.search.trim(), $options: "i" };
    }

    const sortField = req.query.sortBy || "createdAt";
    const sortOrder = req.query.order === "asc" ? 1 : -1;

    const total = await Task.countDocuments(filter);
    const totalPages = Math.ceil(total / limit);

    // Edge case: empty results
    if (total === 0) {
      return res.status(200).json(
        new ApiResponse(
          200,
          {
            total: 0,
            page,
            limit,
            totalPages: 0,
            data: [],
          },
          "No tasks found",
        ),
      );
    }

    // Edge case: page beyond totalPages
    if (page > totalPages) {
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

    // Cache with proper TTL and register key for invalidation
    try {
      await redis.set(cacheKey, responseData, { ex: CACHE_TTL.taskList });
      await registerCacheKey(userId, cacheKey, CACHE_TTL.taskList);
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
    // Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid task ID format",
      });
    }

    // Check cache for single task
    const cacheKey = getTaskCacheKey(req.params.id);
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return res
          .status(200)
          .json(new ApiResponse(200, cached, "Task fetched (cached)"));
      }
    } catch (cacheErr) {
      console.error("Redis read error:", cacheErr.message);
    }

    const task = await Task.findOne({
      _id: req.params.id,
      userId: req.user._id,
    });

    if (!task) {
      return res.status(404).json({
        success: false,
        message: "Task not found",
      });
    }

    // Cache single task with its own TTL
    try {
      await redis.set(cacheKey, task, { ex: CACHE_TTL.taskById });
      await registerCacheKey(req.user._id, cacheKey, CACHE_TTL.taskById);
    } catch (cacheErr) {
      console.error("Redis write error:", cacheErr.message);
    }

    res.status(200).json(new ApiResponse(200, task, "Task fetched"));
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// PUT /api/tasks/:id
const updateTask = async (req, res) => {
  try {
    // Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid task ID format",
      });
    }

    const task = await Task.findOne({
      _id: req.params.id,
      userId: req.user._id,
    });

    if (!task) {
      return res.status(404).json({
        success: false,
        message: "Task not found",
      });
    }

    const { title, description, dueDate, status } = req.body;

    // Nothing to update
    if (!title && !description && !dueDate && !status) {
      return res.status(400).json({
        success: false,
        message:
          "Provide at least one field to update: title, description, dueDate, or status",
      });
    }

    // Title validation
    if (title !== undefined) {
      if (title.trim().length === 0) {
        return res.status(400).json({
          success: false,
          message: "Title cannot be empty",
        });
      }
      if (title.trim().length > 100) {
        return res.status(400).json({
          success: false,
          message: "Title cannot exceed 100 characters",
        });
      }
    }

    // Status validation
    if (status) {
      if (!VALID_STATUSES.includes(status)) {
        return res.status(400).json({
          success: false,
          message: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}`,
        });
      }

      if (status !== task.status) {
        const allowed = STATUS_TRANSITIONS[task.status];
        if (!allowed) {
          return res.status(400).json({
            success: false,
            message:
              "Task is already completed. No further status changes allowed.",
          });
        }
        if (status !== allowed) {
          return res.status(400).json({
            success: false,
            message: `Invalid transition: "${task.status}" → "${status}". Only allowed: "${task.status}" → "${allowed}"`,
          });
        }
      }
    }

    // Due date validation
    if (dueDate) {
      const parsedDate = new Date(dueDate);
      if (isNaN(parsedDate.getTime())) {
        return res.status(400).json({
          success: false,
          message: "Invalid due date format. Use YYYY-MM-DD",
        });
      }
    }

    if (title) task.title = title.trim();
    if (description !== undefined) task.description = description.trim();
    if (dueDate) task.dueDate = dueDate;
    if (status) task.status = status;

    await task.save();

    // Invalidate both list cache and single task cache
    await invalidateUserCache(req.user._id);

    res
      .status(200)
      .json(new ApiResponse(200, task, "Task updated successfully"));
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// DELETE /api/tasks/:id
const deleteTask = async (req, res) => {
  try {
    // Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid task ID format",
      });
    }

    const task = await Task.findOneAndDelete({
      _id: req.params.id,
      userId: req.user._id,
    });

    if (!task) {
      return res.status(404).json({
        success: false,
        message: "Task not found or you do not have permission to delete it",
      });
    }

    // Invalidate all user cache immediately
    await invalidateUserCache(req.user._id);

    res
      .status(200)
      .json(new ApiResponse(200, null, "Task deleted successfully"));
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = { createTask, getTasks, getTaskById, updateTask, deleteTask };
