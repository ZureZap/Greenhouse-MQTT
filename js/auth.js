/**
 * auth.js
 * Lưu trạng thái đăng nhập phía trình duyệt và cung cấp các thao tác xác thực.
 */

import { login as apiLogin, register as apiRegister, logout as apiLogout } from "./api.js";
import { showToast } from "./app.js";

// ===================== AUTH ACTIONS =====================

export async function login(username, password) {
  try {
    const user = await apiLogin(username, password);
    // Lưu vào localStorage đã được api.js thực hiện
    return user;
  } catch (err) {
    throw err;
  }
}

// Đăng ký
export async function register(userData) {
  try {
    const newUser = await apiRegister(userData);
    return newUser;
  } catch (err) {
    throw err;
  }
}

// Đăng xuất
export async function logout() {
  await apiLogout();
}

// ===================== SESSION READERS =====================

// Kiểm tra đã đăng nhập chưa
export function isLoggedIn() {
  const token = localStorage.getItem("token");
  const userStr = localStorage.getItem("user");
  return !!(token && userStr);
}

// Lấy user hiện tại
export function getCurrentUser() {
  const userStr = localStorage.getItem("user");
  if (userStr) {
    try {
      return JSON.parse(userStr);
    } catch (e) {
      return null;
    }
  }
  return null;
}

// Phê duyệt user (gọi API)
export async function approveUser(userId) {
  // Gọi API update status
  const { updateUserStatus } = await import("./api.js");
  return updateUserStatus(userId, "ACTIVE");
}

// Từ chối user (xóa)
export async function rejectUser(userId) {
  const { updateUserStatus } = await import("./api.js");
  return updateUserStatus(userId, "REJECTED");
}
