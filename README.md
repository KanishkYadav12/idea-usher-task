# Task Manager API

A production-ready RESTful API built with Node.js, Express, and MongoDB featuring JWT authentication, pagination, caching, and real-world constraints.

## Tech Stack

- **Runtime:** Node.js
- **Framework:** Express.js v4
- **Database:** MongoDB with Mongoose
- **Authentication:** JWT (jsonwebtoken)
- **Password Hashing:** bcryptjs
- **Caching:** Redis (Upstash)
- **Logging:** Winston
- **Rate Limiting:** express-rate-limit

---

## Getting Started

### Prerequisites
- Node.js v18+
- MongoDB Atlas account
- Upstash Redis account

### Installation

```bash
git clone https://github.com/KanishkYadav12/task-manager-api
cd task-manager-api
npm install
```

### Environment Variables

Create a `.env` file in the root:
PORT=5000
MONGO_URI=your_mongodb_connection_string
JWT_SECRET=your_jwt_secret
JWT_EXPIRES_IN=7d
UPSTASH_REDIS_REST_URL=your_upstash_redis_url
UPSTASH_REDIS_REST_TOKEN=your_upstash_redis_token

### Run the Server

```bash
npm run dev    # development
npm start      # production
```

---

## API Endpoints

### Auth Routes

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| POST | /api/auth/register | Register new user | No |
| POST | /api/auth/login | Login user | No |
| GET | /api/auth/me | Get logged-in profile | Yes |

### Task Routes

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| POST | /api/tasks | Create task | Yes |
| GET | /api/tasks | Get all tasks | Yes |
| GET | /api/tasks/:id | Get task by ID | Yes |
| PUT | /api/tasks/:id | Update task | Yes |
| DELETE | /api/tasks/:id | Delete task | Yes |

### Query Parameters for GET /api/tasks

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| page | Number | 1 | Page number |
| limit | Number | 10 | Results per page |
| status | String | - | Filter by status |
| startDate | Date | - | Filter by due date start |
| endDate | Date | - | Filter by due date end |
| search | String | - | Search by title |
| sortBy | String | createdAt | Sort field |
| order | String | desc | asc or desc |

---

## Folder Structure
src/
├── config/
│   ├── db.js          # MongoDB connection
│   └── redis.js       # Upstash Redis client
├── controllers/
│   ├── auth.controller.js   # Register, login, profile
│   └── task.controller.js   # CRUD + cache logic
├── middleware/
│   ├── auth.middleware.js   # JWT verification
│   ├── error.middleware.js  # Centralized error handler
│   └── rateLimiter.js       # Rate limiting
├── models/
│   ├── user.model.js   # User schema
│   └── task.model.js   # Task schema
├── routes/
│   ├── auth.routes.js  # Auth endpoints
│   └── task.routes.js  # Task endpoints
├── utils/
│   ├── ApiError.js     # Custom error class
│   ├── ApiResponse.js  # Consistent response wrapper
│   └── logger.js       # Winston logger
└── app.js              # Express app setup
server.js               # Entry point

### Why this structure?

Each layer has a single responsibility. Routes handle URL mapping, controllers handle business logic, models handle data, middleware handles cross-cutting concerns. This makes the codebase easy to navigate, test, and scale.

---

## How Authentication Middleware Works
Request → auth.middleware.js
↓
Extract Bearer token from header
↓
jwt.verify(token, JWT_SECRET)
↓
Find user by decoded ID in MongoDB
↓
Attach user to req.user
↓
Call next() → reaches controller

1. Every protected route passes through `protect` middleware
2. It checks for `Authorization: Bearer <token>` header
3. Verifies the JWT signature using `JWT_SECRET`
4. Fetches the user from DB to ensure they still exist
5. Attaches the user object to `req.user` so controllers can use it
6. If any step fails → returns 401 Unauthorized immediately

This ensures users can only access their own data since every query is scoped to `req.user._id`.

---

## How Pagination is Implemented
GET /api/tasks?page=2&limit=5
skip = (page - 1) * limit = (2-1) * 5 = 5
→ skip first 5 documents, return next 5

Response envelope:
```json
{
  "total": 23,
  "page": 2,
  "limit": 5,
  "totalPages": 5,
  "data": [...]
}
```

The `skip/limit` approach is used with Mongoose's `.skip()` and `.limit()` methods. `totalPages` is calculated as `Math.ceil(total / limit)`.

---

## Edge Case Handling

| Edge Case | Handling |
|-----------|----------|
| page > totalPages | Returns 400 with message showing valid range |
| Empty results | Returns 200 with empty data array, total: 0 |
| Invalid status transition | Returns 400 blocking the update |
| Duplicate task title (same day) | Returns 400 preventing creation |
| No token provided | Returns 401 Unauthorized |
| Invalid/expired token | Returns 401 Unauthorized |
| Task not found | Returns 404 Not Found |
| User accessing another user's task | Returns 404 (as if task doesn't exist) |

---

## Business Logic Constraints

### 1. Duplicate Task Prevention
A user cannot create two tasks with the same title on the same day:
```js
Task.findOne({
  userId, title,
  createdAt: { $gte: startOfDay, $lte: endOfDay }
})
```

### 2. Status Transition Guard
Tasks can only move forward in status:
pending → in-progress → completed
Skipping steps or going backward is rejected with a 400 error.

---

## Redis Caching Strategy

- **What is cached:** GET /api/tasks responses
- **Cache key:** `tasks:{userId}:{page}:{limit}:{filters}`
- **TTL:** 60 seconds
- **Invalidation:** Any create, update, or delete operation clears all cache keys for that user

This ensures users always see fresh data after mutations while reducing MongoDB load for frequent reads.

---

## Thinking Questions

### 1. Why did you choose skip/limit pagination?

Skip/limit is the simplest approach to implement and works well at small to medium scale. It integrates naturally with Mongoose, allows random page access (jump to page 5 directly), and is easy to understand. For this assignment's scope it is the right tradeoff.

### 2. What are its drawbacks at scale?

At large datasets (1M+ records), `skip(50000)` forces MongoDB to scan and discard 50,000 documents before returning results. This gets progressively slower as page numbers increase. It also suffers from data inconsistency — if a document is inserted or deleted between page requests, items can appear twice or be skipped entirely.

### 3. How would you optimize for large data (1M+ records)?

Use **cursor-based pagination** (also called keyset pagination):

```js
// Instead of skip
Task.find({ 
  userId, 
  _id: { $gt: lastSeenId }  // start after last seen document
})
.limit(10)
```

This uses MongoDB's index directly (O log n) instead of scanning documents. It stays consistently fast regardless of dataset size. The tradeoff is you can't jump to arbitrary pages — you can only go forward/backward sequentially. For most real-world use cases (infinite scroll, load more) this is acceptable and preferred.

---

## Rate Limiting

- **Window:** 15 minutes
- **Max requests:** 100 per IP
- **Response on limit:** 429 Too Many Requests

---

## Logging

Winston logger writes to:
- Console (all levels)
- `logs/error.log` (errors only)
- `logs/combined.log` (all levels)

Format: `[YYYY-MM-DD HH:mm:ss] LEVEL: message`
