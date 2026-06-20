/**
 * api.js
 * Giao tiếp với backend API (Node.js + Express)
 * Base URL: http://localhost:5000/api
 */

const API_BASE = "http://localhost:5000/api";

// Helper: lấy token từ localStorage
function getToken() {
  return localStorage.getItem("token");
}

// Helper: gửi request
async function request(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const headers = {
    "Content-Type": "application/json",
    ...options.headers
  };
  const token = getToken();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const config = {
    ...options,
    headers
  };
  const response = await fetch(url, config);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Lỗi không xác định" }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
  return response.json();
}

// ======================================================================
// AUTH
// ======================================================================

export async function login(username, password) {
  const result = await request("/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password })
  });
  if (result.token) {
    localStorage.setItem("token", result.token);
    localStorage.setItem("user", JSON.stringify(result));
  }
  return result;
}

export async function register(userData) {
  return request("/auth/register", {
    method: "POST",
    body: JSON.stringify(userData)
  });
}

export async function getCurrentUser() {
  return request("/auth/me");
}

export async function changePassword(oldPassword, newPassword, confirmPassword) {
  return request("/auth/change-password", {
    method: "PUT",
    body: JSON.stringify({ oldPassword, newPassword, confirmPassword })
  });
}

export async function forgotPassword(identifier, phone, newPassword, confirmPassword) {
  return request("/auth/forgot-password", {
    method: "PUT",
    body: JSON.stringify({ identifier, phone, newPassword, confirmPassword })
  });
}

export async function logout() {
  try {
    await request("/auth/logout", { method: "POST" });
  } finally {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
  }
}

// ======================================================================
// USERS
// ======================================================================

export async function getUsers() {
  return request("/users");
}

export async function updateUserRole(userId, role) {
  return request(`/users/${userId}/role`, {
    method: "PUT",
    body: JSON.stringify({ role })
  });
}

export async function updateUserStatus(userId, status) {
  return request(`/users/${userId}/status`, {
    method: "PUT",
    body: JSON.stringify({ status })
  });
}

export async function deleteUser(userId) {
  return request(`/users/${userId}`, { method: "DELETE" });
}

// ======================================================================
// FARMS & GREENHOUSES
// ======================================================================

export async function getFarms() {
  return request("/farms");
}

export async function getGreenhouses(farmId = null) {
  const endpoint = farmId ? `/greenhouses/${farmId}` : "/greenhouses";
  return request(endpoint);
}

// ======================================================================
// ZONES
// ======================================================================

export async function getZones() {
  return request("/zones");
}

export async function createZone(data) {
  return request("/zones", {
    method: "POST",
    body: JSON.stringify(data)
  });
}

export async function updateZone(id, data) {
  return request(`/zones/${id}`, {
    method: "PUT",
    body: JSON.stringify(data)
  });
}

export async function deleteZone(id, type = "zone") {
  return request(`/zones/${id}?type=${encodeURIComponent(type)}`, {
    method: "DELETE"
  });
}

export async function updateZoneCycle(id, adjustmentDays, reason) {
  return request(`/zones/${id}/cycle-adjustment`, {
    method: "PUT",
    body: JSON.stringify({ adjustmentDays, reason })
  });
}

// ======================================================================
// DEVICES
// ======================================================================

export async function getDevices() {
  return request("/devices");
}

export async function getDevice(id) {
  return request(`/devices/${id}`);
}

export async function createDevice(data) {
  return request("/devices", {
    method: "POST",
    body: JSON.stringify(data)
  });
}

export async function updateDevice(id, data) {
  return request(`/devices/${id}`, {
    method: "PUT",
    body: JSON.stringify(data)
  });
}

export async function deleteDevice(id) {
  return request(`/devices/${id}`, {
    method: "DELETE"
  });
}

// ======================================================================
// CONTROL PROPERTIES
// ======================================================================

export async function getControlProperties() {
  return request("/control-properties");
}

export async function updateControlProperty(deviceId, data) {
  return request(`/control-properties/${deviceId}`, {
    method: "PUT",
    body: JSON.stringify(data)
  });
}

// ======================================================================
// GATEWAYS
// ======================================================================

export async function getGateways() {
  return request("/gateways");
}

// ======================================================================
// RECIPES
// ======================================================================

export async function getRecipes() {
  return request("/recipes");
}

export async function getRecipe(id) {
  return request(`/recipes/${id}`);
}

export async function createRecipe(data) {
  return request("/recipes", {
    method: "POST",
    body: JSON.stringify(data)
  });
}

export async function updateRecipe(id, data) {
  return request(`/recipes/${id}`, {
    method: "PUT",
    body: JSON.stringify(data)
  });
}

export async function deleteRecipe(id) {
  return request(`/recipes/${id}`, {
    method: "DELETE"
  });
}

// ======================================================================
// GROWTH STAGES & THRESHOLDS
// ======================================================================

export async function getStages(recipeId) {
  return request(`/recipes/${recipeId}/stages`);
}

export async function getThresholds(stageId) {
  return request(`/stages/${stageId}/thresholds`);
}

export async function createStage(recipeId, data) {
  return request(`/recipes/${recipeId}/stages`, {
    method: "POST",
    body: JSON.stringify(data)
  });
}

export async function updateStage(stageId, data) {
  return request(`/stages/${stageId}`, {
    method: "PUT",
    body: JSON.stringify(data)
  });
}

export async function deleteStage(stageId) {
  return request(`/stages/${stageId}`, {
    method: "DELETE"
  });
}

// ======================================================================
// ALERTS
// ======================================================================

export async function getAlerts() {
  return request("/alerts");
}

export async function updateAlertStatus(id, status, acknowledgedBy = null) {
  return request(`/alerts/${id}/status`, {
    method: "PUT",
    body: JSON.stringify({ status, acknowledgedBy })
  });
}

export async function deleteAlert(id) {
  return request(`/alerts/${id}`, {
    method: "DELETE"
  });
}

// ======================================================================
// LOGS
// ======================================================================

export async function getLogs() {
  return request("/logs");
}

export async function getSensorData(greenhouseId = null, limit = 200) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (greenhouseId) params.set("greenhouseId", String(greenhouseId));
  return request(`/sensor-data?${params.toString()}`);
}

// ======================================================================
// STATISTICS
// ======================================================================

export async function getGreenhouseStats(greenhouseId) {
  return request(`/stats/greenhouse/${greenhouseId}`);
}

export async function getGlobalStats() {
  return request("/stats/global");
}

// ======================================================================
// EXPORT DEFAULT (tiện dùng)
// ======================================================================

export default {
  login,
  register,
  getCurrentUser,
  changePassword,
  forgotPassword,
  logout,
  getUsers,
  updateUserRole,
  updateUserStatus,
  deleteUser,
  getFarms,
  getGreenhouses,
  getZones,
  createZone,
  updateZone,
  deleteZone,
  updateZoneCycle,
  getDevices,
  getDevice,
  createDevice,
  updateDevice,
  deleteDevice,
  getControlProperties,
  updateControlProperty,
  getGateways,
  getRecipes,
  getRecipe,
  createRecipe,
  updateRecipe,
  deleteRecipe,
  getStages,
  getThresholds,
  createStage,
  updateStage,
  deleteStage,
  getAlerts,
  updateAlertStatus,
  deleteAlert,
  getLogs,
  getSensorData,
  getGreenhouseStats,
  getGlobalStats
};
