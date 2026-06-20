/**
 * app.js
 * Ứng dụng chính - điều phối các trang, xử lý điều hướng, modal, xác thực,
 * và hiển thị icon chuông phê duyệt cho OWNER.
 */

import { renderDashboardPage } from "./dashboard.js";
import { renderDevicesPage } from "./devices.js";
import { renderZonesPage } from "./zones.js";
import { renderGrowthPage } from "./growth.js";
import { renderControlPage } from "./control.js";
import { renderAlertsPage } from "./alerts.js";
import { renderLogsPage } from "./logs.js";
import { renderLoginPage } from "./pages/login.js";
import { renderRegisterPage } from "./pages/register.js";
import { renderUserApprovalPage } from "./pages/userApproval.js";
import { isLoggedIn, logout, getCurrentUser } from "./auth.js";
import { changePassword } from "./api.js";

// ===================== TIỆN ÍCH CHUNG =====================

export function showToast(msg, type = "success") {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

export function openModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.add("open");
}

export function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.remove("open");
}

// ===================== ĐIỀU HƯỚNG =====================

let isAuth = false;
const ROLE_PAGES = {
  OWNER: ["dashboard", "devices", "zones", "growth", "control", "alerts", "logs", "user-approval"],
  TECHNICIAN: ["dashboard", "devices", "growth", "control"],
  OPERATOR: ["dashboard", "control"]
};

function canAccessPage(pageName) {
  const role = getCurrentUser()?.role;
  return Boolean(role && ROLE_PAGES[role]?.includes(pageName));
}

function renderPage(pageName) {
  const pageMap = {
    dashboard: renderDashboardPage,
    devices: renderDevicesPage,
    zones: renderZonesPage,
    growth: renderGrowthPage,
    control: renderControlPage,
    alerts: renderAlertsPage,
    logs: renderLogsPage,
    login: renderLoginPage,
    register: renderRegisterPage,
    "user-approval": renderUserApprovalPage
  };
  const renderFn = pageMap[pageName];
  if (renderFn) renderFn();
  else renderDashboardPage();
}

function handleRoute() {
  let hash = window.location.hash.slice(1) || "dashboard";
  const publicPages = ["login", "register"];
  const isPublic = publicPages.includes(hash);

  if (!isAuth && !isPublic) {
    window.location.hash = "login";
    return;
  }
  if (isAuth && isPublic) {
    window.location.hash = "dashboard";
    return;
  }
  if (isAuth && !isPublic && !canAccessPage(hash)) {
    showToast("Bạn không có quyền truy cập chức năng này", "warning");
    window.location.hash = "dashboard";
    return;
  }
  // Cập nhật active menu (chỉ khi đã đăng nhập và không phải public)
  if (isAuth && !isPublic) {
    document.querySelectorAll(".nav-item").forEach((item) => {
      if (item.dataset.page === hash) item.classList.add("active");
      else item.classList.remove("active");
    });
  }
  document.querySelectorAll(".page").forEach((page) => page.classList.remove("active"));
  const activePage = document.getElementById(`page-${hash}`);
  if (activePage) activePage.classList.add("active");
  renderPage(hash);
}

// ===================== THÀNH PHẦN SIDEBAR =====================

function addLogoutButton() {
  const nav = document.querySelector(".sidebar-nav");
  if (!nav || document.getElementById("logout-item")) return;
  const logoutBtn = document.createElement("a");
  logoutBtn.id = "logout-item";
  logoutBtn.className = "nav-item";
  logoutBtn.href = "#";
  logoutBtn.innerHTML = '<span class="nav-icon">🚪</span> Đăng xuất';
  logoutBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    await logout();
    isAuth = false;
    window.location.hash = "login";
    window.dispatchEvent(new Event("auth-changed"));
    document.getElementById("sidebar").style.display = "none";
    // Xóa icon chuông khi logout
    const bell = document.getElementById("bell-container");
    if (bell) bell.remove();
  });
  nav.appendChild(logoutBtn);
}

function addOwnerMenu() {
  const nav = document.querySelector(".sidebar-nav");
  if (!nav || document.getElementById("owner-approval-item")) return;
  const currentUser = getCurrentUser();
  if (currentUser && currentUser.role === "OWNER") {
    const approvalItem = document.createElement("a");
    approvalItem.id = "owner-approval-item";
    approvalItem.className = "nav-item";
    approvalItem.href = "#";
    approvalItem.innerHTML = '<span class="nav-icon">👥</span> Quản lý tài khoản';
    approvalItem.addEventListener("click", (e) => {
      e.preventDefault();
      window.location.hash = "user-approval";
    });
    // Chèn trước nút logout
    const logoutBtn = document.getElementById("logout-item");
    if (logoutBtn) nav.insertBefore(approvalItem, logoutBtn);
    else nav.appendChild(approvalItem);
  }
}

function addChangePasswordMenu() {
  const nav = document.querySelector(".sidebar-nav");
  if (!nav || document.getElementById("change-password-item")) return;
  const item = document.createElement("a");
  item.id = "change-password-item";
  item.className = "nav-item";
  item.href = "#";
  item.innerHTML = '<span class="nav-icon">🔑</span> Đổi mật khẩu';
  item.addEventListener("click", (event) => {
    event.preventDefault();
    openChangePasswordModal();
  });
  const logoutItem = document.getElementById("logout-item");
  if (logoutItem) nav.insertBefore(item, logoutItem);
  else nav.appendChild(item);
}

function openChangePasswordModal() {
  document.getElementById("change-password-modal")?.remove();
  document.body.insertAdjacentHTML(
    "beforeend",
    `<div class="modal-overlay" id="change-password-modal">
      <div class="modal" style="width:450px;max-width:95vw">
        <div class="modal-title">Đổi mật khẩu</div>
        <div class="form-group"><label class="form-label">Mật khẩu cũ</label>
          <input class="form-input" id="old-password" type="password" autocomplete="current-password"></div>
        <div class="form-group"><label class="form-label">Mật khẩu mới</label>
          <input class="form-input" id="new-password" type="password" autocomplete="new-password"></div>
        <div class="form-group"><label class="form-label">Nhập lại mật khẩu mới</label>
          <input class="form-input" id="confirm-password" type="password" autocomplete="new-password"></div>
        <div class="modal-actions">
          <button class="btn btn-outline" id="cancel-change-password">Hủy</button>
          <button class="btn btn-primary" id="save-change-password">Đổi mật khẩu</button>
        </div>
      </div>
    </div>`
  );
  const modal = document.getElementById("change-password-modal");
  openModal("change-password-modal");
  document.getElementById("cancel-change-password").addEventListener("click", () => modal.remove());
  document.getElementById("save-change-password").addEventListener("click", async () => {
    const oldPassword = document.getElementById("old-password").value;
    const newPassword = document.getElementById("new-password").value;
    const confirmPassword = document.getElementById("confirm-password").value;
    try {
      await changePassword(oldPassword, newPassword, confirmPassword);
      modal.remove();
      showToast("Đổi mật khẩu thành công");
    } catch (err) {
      showToast("Lỗi đổi mật khẩu: " + err.message, "error");
    }
  });
}

function toggleSidebar() {
  const sidebar = document.getElementById("sidebar");
  if (isAuth) {
    sidebar.style.display = "flex";
    addLogoutButton();
    addChangePasswordMenu();
    document.querySelectorAll(".sidebar-nav .nav-item[data-page]").forEach((item) => {
      item.style.display = canAccessPage(item.dataset.page) ? "flex" : "none";
    });
    const ownerItem = document.getElementById("owner-approval-item");
    if (getCurrentUser()?.role !== "OWNER") ownerItem?.remove();
    addOwnerMenu();
  } else {
    sidebar.style.display = "none";
    document.getElementById("owner-approval-item")?.remove();
    document.getElementById("change-password-item")?.remove();
    document.getElementById("logout-item")?.remove();
    document.querySelectorAll(".sidebar-nav .nav-item[data-page]").forEach((item) => {
      item.style.display = "none";
    });
  }
}

// ===================== KHỞI TẠO =====================

isAuth = isLoggedIn();
toggleSidebar();

window.addEventListener("hashchange", () => handleRoute());

window.addEventListener("auth-changed", () => {
  isAuth = isLoggedIn();
  toggleSidebar();
  handleRoute();
});

// Sự kiện click menu
document.querySelectorAll(".nav-item").forEach((menuItem) => {
  menuItem.addEventListener("click", (e) => {
    if (!isAuth) return;
    e.preventDefault();
    const pageName = menuItem.dataset.page;
    if (pageName) window.location.hash = pageName;
  });
});

// Đóng modal khi click overlay
document.body.addEventListener("click", (e) => {
  if (e.target.classList?.contains("modal-overlay")) {
    e.target.classList.remove("open");
  }
});

window.closeModal = closeModal;
window.openModal = openModal;

// Khởi chạy route đầu tiên
handleRoute();
