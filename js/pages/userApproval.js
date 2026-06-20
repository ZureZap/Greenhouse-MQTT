/**
 * userApproval.js
 * Cho phép OWNER xem, phân quyền và phê duyệt tài khoản đang chờ.
 */

import { getCurrentUser } from "../auth.js";
import { showToast, openModal, closeModal } from "../app.js";
import { escapeHtml } from "../utils.js";
import { getUsers, updateUserRole, updateUserStatus, deleteUser } from "../api.js";

// ===================== BIẾN TOÀN CỤC =====================
let users = [];
let pendingCount = 0;

// ===================== CẬP NHẬT BADGE =====================
function updatePageBellBadge() {
  const badge = document.getElementById("bell-badge-page");
  if (!badge) return;
  pendingCount = users.filter((u) => u.status === "PENDING").length;
  badge.textContent = pendingCount;
  badge.style.display = pendingCount > 0 ? "inline" : "none";
}

// ===================== LOAD DỮ LIỆU =====================
async function loadUsers() {
  try {
    users = await getUsers();
    updatePageBellBadge();
    return users;
  } catch (err) {
    showToast("Lỗi tải danh sách người dùng: " + err.message, "error");
    throw err;
  }
}

// ===================== POP-UP DANH SÁCH PENDING =====================
function showPendingPopup() {
  const pendingUsers = users.filter((u) => u.status === "PENDING");
  if (pendingUsers.length === 0) {
    showToast("Không có tài khoản nào chờ phê duyệt", "info");
    return;
  }

  let listHtml = pendingUsers
    .map(
      (user) => `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid #f0f0f0;">
            <div>
                <div style="font-weight:600;">${user.username}</div>
                <div style="font-size:0.8rem; color:#6b7280;">${user.email} - ${user.phone}</div>
                <div style="font-size:0.75rem; color:#6b7280;">Vai trò: ${user.role}</div>
            </div>
            <div style="display:flex; gap:6px;">
                <button class="btn btn-success btn-sm popup-approve" data-id="${user.id}">✔</button>
                <button class="btn btn-error btn-sm popup-reject" data-id="${user.id}">✖</button>
            </div>
        </div>
    `
    )
    .join("");

  const modalHtml = `
        <div class="modal-overlay" id="pending-popup">
            <div class="modal" style="width:500px; max-width:90vw;">
                <div class="modal-title">🔔 Tài khoản chờ phê duyệt</div>
                <div style="max-height:400px; overflow-y:auto;">
                    ${listHtml}
                </div>
                <div class="modal-actions">
                    <button class="btn btn-outline" id="close-pending-popup">Đóng</button>
                </div>
            </div>
        </div>
    `;
  document.body.insertAdjacentHTML("beforeend", modalHtml);
  openModal("pending-popup");

  document.querySelectorAll(".popup-approve").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      try {
        await updateUserStatus(id, "ACTIVE");
        const user = users.find((u) => String(u.id) === String(id));
        if (user) user.status = "ACTIVE";
        showToast("Đã phê duyệt", "success");
        closeModal("pending-popup");
        document.getElementById("pending-popup").remove();
        updatePageBellBadge();
        if (document.getElementById("page-user-approval")?.classList?.contains("active")) {
          renderUserApprovalPage();
        }
        if (users.some((u) => u.status === "PENDING")) {
          showPendingPopup();
        }
      } catch (err) {
        showToast("Lỗi: " + err.message, "error");
      }
    });
  });

  document.querySelectorAll(".popup-reject").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      if (confirm("Từ chối sẽ xóa tài khoản này. Bạn chắc chắn?")) {
        try {
          await updateUserStatus(id, "REJECTED");
          users = users.filter((u) => String(u.id) !== String(id));
          showToast("Đã từ chối", "info");
          closeModal("pending-popup");
          document.getElementById("pending-popup").remove();
          updatePageBellBadge();
          if (document.getElementById("page-user-approval")?.classList?.contains("active")) {
            renderUserApprovalPage();
          }
          if (users.some((u) => u.status === "PENDING")) {
            showPendingPopup();
          }
        } catch (err) {
          showToast("Lỗi: " + err.message, "error");
        }
      }
    });
  });

  document.getElementById("close-pending-popup").addEventListener("click", () => {
    closeModal("pending-popup");
    document.getElementById("pending-popup").remove();
  });

  document.getElementById("pending-popup").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) {
      closeModal("pending-popup");
      document.getElementById("pending-popup").remove();
    }
  });
}

// ===================== TRANG QUẢN LÝ TÀI KHOẢN =====================
export async function renderUserApprovalPage() {
  const container = document.getElementById("page-user-approval");
  if (!container) return;

  const currentUser = getCurrentUser();
  if (!currentUser || currentUser.role !== "OWNER") {
    container.innerHTML =
      '<div class="card" style="padding:20px; text-align:center;">Bạn không có quyền truy cập trang này.</div>';
    return;
  }

  try {
    await loadUsers();
  } catch (err) {
    container.innerHTML = `<div class="card" style="padding:20px; text-align:center; color:#ef4444;">Lỗi tải dữ liệu: ${err.message}</div>`;
    return;
  }

  const activeUsers = users.filter((u) => u.status === "ACTIVE" && !u.isPrimaryOwner);
  activeUsers.sort((a, b) => a.username.localeCompare(b.username));

  let html = `
        <div class="page-header" style="position: relative;">
            <div>
                <div class="page-title">Quản lý tài khoản</div>
                <div class="page-sub">Danh sách người dùng đã được phê duyệt</div>
            </div>
            <div style="position: absolute; top: 0; right: 0; display: flex; align-items: center;">
                <div id="bell-container-page" style="cursor:pointer; display:flex; align-items:center; gap:6px; padding:6px 12px; border-radius:8px; background:#f3f4f6; transition:background 0.15s;" onclick="window.showPendingPopup()">
                    <span style="font-size:24px;">🔔</span>
                    <span id="bell-badge-page" style="background:#ef4444; color:white; border-radius:50%; padding:2px 8px; font-size:0.75rem; font-weight:600; display:${pendingCount > 0 ? "inline" : "none"};">${pendingCount}</span>
                </div>
            </div>
        </div>
        <div class="card">
            <div class="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th>Tên đăng nhập</th>
                            <th>Email</th>
                            <th>Số điện thoại</th>
                            <th>Vai trò</th>
                            <th>Trạng thái</th>
                            <th>Hành động</th>
                        </tr>
                    </thead>
                    <tbody>
    `;
  if (activeUsers.length === 0) {
    html += `<tr><td colspan="6" style="text-align:center; color:#6b7280;">Chưa có tài khoản nào được phê duyệt.</td></tr>`;
  } else {
    activeUsers.forEach((user) => {
      const roleOptions = ["OPERATOR", "TECHNICIAN", "OWNER"];
      const roleLabels = {
        OPERATOR: "Nhân viên vận hành",
        TECHNICIAN: "Kỹ thuật viên",
        OWNER: "Chủ trang trại"
      };
      html += `<tr>
                        <td>${escapeHtml(user.username)}</td>
                        <td>${escapeHtml(user.email)}</td>
                        <td>${escapeHtml(user.phone || "-")}</td>
                        <td>
                            <select class="form-select role-select" data-id="${user.id}" style="width:auto; display:inline-block;">
                                ${roleOptions.map((r) => `<option value="${r}" ${user.role === r ? "selected" : ""}>${roleLabels[r]}</option>`).join("")}
                            </select>
                        </td>
                        <td><span class="chip chip-success">Đã kích hoạt</span></td>
                        <td><button class="btn btn-error btn-sm delete-user" data-id="${user.id}" data-name="${escapeHtml(user.username)}">Xóa</button></td>
                     </tr>`;
    });
  }
  html += `</tbody></table></div></div>`;
  container.innerHTML = html;

  window.showPendingPopup = showPendingPopup;

  // Sự kiện đổi role
  document.querySelectorAll(".role-select").forEach((select) => {
    select.addEventListener("change", async (e) => {
      const userId = e.target.dataset.id;
      const newRole = e.target.value;
      try {
        await updateUserRole(userId, newRole);
        const user = users.find((u) => String(u.id) === String(userId));
        if (user) user.role = newRole;
        showToast(`Đã cập nhật role cho ${user.username}`, "success");
      } catch (err) {
        showToast("Lỗi cập nhật role: " + err.message, "error");
      }
    });
  });

  document.querySelectorAll(".delete-user").forEach((button) => {
    button.addEventListener("click", async () => {
      const userId = button.dataset.id;
      const userName = button.dataset.name;
      if (!confirm(`Xóa tài khoản "${userName}"?`)) return;
      try {
        await deleteUser(userId);
        users = users.filter((user) => String(user.id) !== String(userId));
        showToast(`Đã xóa tài khoản ${userName}`, "info");
        renderUserApprovalPage();
      } catch (err) {
        showToast("Lỗi xóa tài khoản: " + err.message, "error");
      }
    });
  });

  updatePageBellBadge();
}
