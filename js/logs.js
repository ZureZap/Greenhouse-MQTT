/**
 * logs.js
 * Quản lý trang Nhật ký hệ thống - hiển thị danh sách các thao tác của người dùng (Audit Trail),
 * hỗ trợ lọc theo hành động và vai trò, thống kê tổng số bản ghi, số lần ghi đè và số người dùng hoạt động.
 * Sử dụng API backend thay vì state.js.
 */

import { escapeHtml } from "./utils.js";
import { getLogs } from "./api.js";

// ===================== BIẾN TOÀN CỤC =====================
let logs = [];
let logRefreshTimer = null;

const entityTypeMap = {
  DEVICE: "Thiết bị",
  ZONE: "Zone",
  GREENHOUSE: "Nhà kính",
  FARM: "Trang trại",
  RECIPE: "Công thức",
  GROWTH_STAGE: "Giai đoạn",
  ALERT: "Cảnh báo",
  USER: "Tài khoản",
  SIMULATION: "Mô phỏng"
};

function formatLogTime(timestamp) {
  if (!timestamp) return "-";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("vi-VN", { timeZone: "UTC" });
}

function scheduleLogRefresh() {
  clearTimeout(logRefreshTimer);
  logRefreshTimer = setTimeout(async () => {
    const page = document.getElementById("page-logs");
    if (!page?.classList.contains("active")) return;
    try {
      await loadLogs();
      renderLogs();
      scheduleLogRefresh();
    } catch (err) {
      console.error("Lỗi tự động cập nhật log:", err);
    }
  }, 10000);
}

// ===================== LOAD DỮ LIỆU =====================
async function loadLogs() {
  try {
    logs = await getLogs();
    return logs;
  } catch (err) {
    console.error("Lỗi tải logs:", err);
    logs = [];
    throw err;
  }
}

// ===================== RENDER DỮ LIỆU =====================
export async function renderLogs() {
  // Kiểm tra các phần tử bộ lọc tồn tại
  const filterAction = document.getElementById("log-filter-action");
  const filterRole = document.getElementById("log-filter-role");
  const filterEntity = document.getElementById("log-filter-entity");
  const searchInput = document.getElementById("log-search");
  if (!filterAction || !filterRole || !filterEntity || !searchInput) return;

  const actionFilter = filterAction.value;
  const roleFilter = filterRole.value;
  const entityFilter = filterEntity.value;
  const searchKeyword = searchInput.value.trim().toLocaleLowerCase("vi-VN");

  // Lọc logs
  const filteredLogs = logs.filter(
    (log) =>
      (actionFilter === "ALL" || log.triggeredBy === actionFilter) &&
      (roleFilter === "ALL" || log.userRole === roleFilter) &&
      (entityFilter === "ALL" || log.entityType === entityFilter) &&
      (!searchKeyword ||
        [log.userName, log.entityName, log.description, log.entityType]
          .filter((value) => value !== null && value !== undefined)
          .some((value) => String(value).toLocaleLowerCase("vi-VN").includes(searchKeyword)))
  );

  // --- Cập nhật 3 card thống kê ---
  const totalEl = document.getElementById("log-total");
  if (totalEl) totalEl.textContent = logs.length;

  const overridesEl = document.getElementById("log-overrides");
  if (overridesEl)
    overridesEl.textContent = logs.filter((log) => log.triggeredBy === "SYSTEM").length;

  const usersEl = document.getElementById("log-users");
  if (usersEl)
    usersEl.textContent = new Set(logs.filter((log) => log.userId).map((log) => log.userId)).size;

  // --- Ánh xạ vai trò ---
  const roleMap = {
    OWNER: "chip-error",
    TECHNICIAN: "chip-info",
    OPERATOR: "chip-default"
  };
  // --- Render bảng ---
  const tableBody = document.getElementById("log-table");
  if (tableBody) {
    if (filteredLogs.length === 0) {
      tableBody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:#6b7280;">Không có bản ghi nào phù hợp.</td></tr>`;
      return;
    }
    tableBody.innerHTML = filteredLogs
      .map(
        (log) => `
            <tr>
                <td style="font-size:0.82rem">${formatLogTime(log.timestamp)}</td>
                <td>
                    <div style="font-weight:500">${escapeHtml(log.userName || "Hệ thống")}</div>
                    <div style="font-size:0.75rem;color:#9ca3af">${escapeHtml(log.userId || "-")}</div>
                </td>
                <td><span class="chip ${roleMap[log.userRole] || "chip-default"}">${escapeHtml(log.userRole || "-")}</span></td>
                <td><span class="chip ${log.triggeredBy === "SYSTEM" ? "chip-info" : "chip-success"}">${log.triggeredBy === "SYSTEM" ? "Hệ thống" : "Người dùng"}</span></td>
                <td>
                    <div style="font-weight:500">${escapeHtml(log.entityName || `${entityTypeMap[log.entityType] || "Đối tượng"} #${log.entityId ?? "-"}`)}</div>
                    <div style="font-size:0.75rem;color:#9ca3af">${escapeHtml(entityTypeMap[log.entityType] || log.entityType || "-")}</div>
                </td>
                <td style="font-size:0.82rem;max-width:360px">${escapeHtml(log.description || "-")}</td>
            </tr>
        `
      )
      .join("");
  }
}

// ===================== RENDER TOÀN BỘ TRANG =====================
export async function renderLogsPage() {
  clearTimeout(logRefreshTimer);
  const container = document.getElementById("page-logs");
  if (!container) return;

  try {
    await loadLogs();
  } catch (err) {
    container.innerHTML = `<div class="card" style="padding:20px; text-align:center; color:#ef4444;">Lỗi tải dữ liệu: ${err.message}</div>`;
    return;
  }

  container.innerHTML = `
        <div class="page-header">
            <div>
                <div class="page-title">Nhật ký Hệ thống</div>
                    <div class="page-sub">Theo dõi thao tác điều khiển từ người dùng và hệ thống</div>
            </div>
        </div>

        <!-- 3 Card thống kê -->
        <div class="card" style="margin-bottom:16px">
            <div class="grid grid-3">
                <div style="background:#dbeafe;border-radius:8px;padding:16px">
                    <div style="font-size:2rem;font-weight:700;color:#3b82f6" id="log-total">0</div>
                    <div style="font-size:0.85rem;color:#6b7280">Tổng số bản ghi</div>
                </div>
                <div style="background:#fef3c7;border-radius:8px;padding:16px">
                    <div style="font-size:2rem;font-weight:700;color:#f59e0b" id="log-overrides">0</div>
                    <div style="font-size:0.85rem;color:#6b7280">Thao tác tự động</div>
                </div>
                <div style="background:#dcfce7;border-radius:8px;padding:16px">
                    <div style="font-size:2rem;font-weight:700;color:#10b981" id="log-users">0</div>
                    <div style="font-size:0.85rem;color:#6b7280">Người dùng hoạt động</div>
                </div>
            </div>
        </div>

        <!-- Bảng log + bộ lọc -->
        <div class="card">
            <div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap">
                <div>
                    <label class="form-label">Nguồn thao tác</label>
                    <select class="form-select" id="log-filter-action" style="width:180px">
                        <option value="ALL">Tất cả</option>
                        <option value="USER">Người dùng</option>
                        <option value="SYSTEM">Hệ thống</option>
                    </select>
                </div>
                <div>
                    <label class="form-label">Loại đối tượng</label>
                    <select class="form-select" id="log-filter-entity" style="width:180px">
                        <option value="ALL">Tất cả</option>
                        ${Object.entries(entityTypeMap)
                          .map(([value, label]) => `<option value="${value}">${label}</option>`)
                          .join("")}
                    </select>
                </div>
                <div style="flex:1;min-width:220px">
                    <label class="form-label">Tìm kiếm</label>
                    <input class="form-input" id="log-search" placeholder="Người dùng, đối tượng, nội dung...">
                </div>
                <div style="align-self:end">
                    <button class="btn btn-outline" id="refresh-logs">Làm mới</button>
                </div>
                <div>
                    <label class="form-label">Lọc theo vai trò</label>
                    <select class="form-select" id="log-filter-role" style="width:200px">
                        <option value="ALL">Tất cả</option>
                        <option value="OWNER">Chủ trang trại</option>
                        <option value="TECHNICIAN">Kỹ thuật viên</option>
                        <option value="OPERATOR">Người vận hành</option>
                    </select>
                </div>
            </div>

            <div class="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th>Thời gian</th>
                            <th>Người dùng</th>
                            <th>Vai trò</th>
                            <th>Nguồn</th>
                            <th>Đối tượng</th>
                            <th>Nội dung</th>
                        </tr>
                    </thead>
                    <tbody id="log-table"></tbody>
                </table>
            </div>

            <div style="background:#fef9c3;border-radius:8px;padding:12px;margin-top:16px;font-size:0.82rem">
                <div style="font-weight:600;margin-bottom:4px">🔒 Bảo mật Audit Trail:</div>
                <div>Không ai có quyền xóa hoặc chỉnh sửa bảng nhật ký này. Mọi thao tác đều được lưu trữ vĩnh viễn.</div>
            </div>
        </div>
    `;

  await renderLogs();
  document
    .querySelectorAll("#log-filter-action, #log-filter-role, #log-filter-entity")
    .forEach((element) => element.addEventListener("change", renderLogs));
  document.getElementById("log-search").addEventListener("input", renderLogs);
  document.getElementById("refresh-logs").addEventListener("click", async () => {
    await loadLogs();
    renderLogs();
    scheduleLogRefresh();
  });
  scheduleLogRefresh();
}

// ===================== EXPOSE GLOBAL =====================
window.renderLogs = renderLogs;
