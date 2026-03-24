const redisClient = require("../config/redis");

const cacheMiddleware = (ttl = 60) => {
  return async (req, res, next) => {
    try {
      // Unique key based on URL + query params
      const key = `cache:${req.originalUrl}`;

      const cachedData = await redisClient.get(key);

      if (cachedData) {
        console.log("⚡ Cache hit:", key);
        return res.json(JSON.parse(cachedData));
      }

      console.log("🐢 Cache miss:", key);

      // Override res.json to store response in Redis
      const originalJson = res.json.bind(res);

      res.json = async (data) => {
        await redisClient.setEx(key, ttl, JSON.stringify(data));
        return originalJson(data);
      };

      next();
    } catch (err) {
      console.error("Cache error:", err);
      next(); // fallback to normal flow
    }
  };
};

module.exports = cacheMiddleware;