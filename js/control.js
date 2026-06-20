/**
 * control.js
 * Quản lý bảng điều khiển thiết bị OUTPUT (actuator).
 * Dựa trên ERD: Device (loại OUTPUT_DEVICE) có controlProperties (1-1).
 * Sử dụng API backend thay vì state.js.
 */

import { showToast } from "./app.js";
import { getCurrentUser } from "./auth.js";
import { getDevices, getControlProperties, updateControlProperty, getZones } from "./api.js";
import {
  buildZoneTree,
  getGreenhouses,
  getGreenhouseIdByZoneId,
  getZoneName,
  getTimeRemaining
} from "./utils.js";

// ===================== BIẾN TOÀN CỤC =====================
let filterGreenhouseId = null;
let devices = [];
let controlProperties = [];
let zones = [];

// ===================== LOAD DỮ LIỆU =====================
async function loadControlData() {
  try {
    const [loadedDevices, loadedControls, flatZones] = await Promise.all([
      getDevices(),
      getControlProperties(),
      getZones()
    ]);
    devices = loadedDevices;
    controlProperties = loadedControls;
    zones = buildZoneTree(flatZones);
    return { devices, controlProperties, zones };
  } catch (err) {
    showToast("Lỗi tải dữ liệu điều khiển: " + err.message, "error");
    throw err;
  }
}

// ===================== RENDER =====================
export async function renderControls() {
  const container = document.getElementById("control-cards");
  if (!container) return;

  // Lấy danh sách actuator (device_type === 'OUTPUT_DEVICE')
  const actuatorDevices = devices.filter((d) => d.device_type === "OUTPUT_DEVICE");
  const controlMap = {};
  controlProperties.forEach((cp) => {
    controlMap[cp.device_id] = cp;
  });

  let devicesWithControl = actuatorDevices
    .filter((d) => controlMap[d.id])
    .map((d) => ({
      ...d,
      control: controlMap[d.id]
    }));

  // Lọc theo greenhouse
  if (filterGreenhouseId) {
    devicesWithControl = devicesWithControl.filter((d) => {
      const ghId = getGreenhouseIdByZoneId(d.zone_id, zones);
      return String(ghId) === String(filterGreenhouseId);
    });
  }

  if (devicesWithControl.length === 0) {
    container.innerHTML = `<div class="card" style="padding:20px; text-align:center; color:#6b7280;">
            ${filterGreenhouseId ? "Không có thiết bị điều khiển nào trong nhà kính này." : "Chưa có thiết bị điều khiển."}
        </div>`;
    return;
  }

  container.innerHTML = devicesWithControl
    .map((device) => {
      const control = device.control;
      const isManual = control.mode === "MANUAL";
      const technicianAutoOnly = getCurrentUser()?.role === "TECHNICIAN";
      const isActive = control.isActive;
      const zoneName = getZoneName(device.zone_id, zones) || "N/A";

      return `
        <div class="control-card ${isManual ? "control-manual" : "control-auto"}">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px">
                <div style="display:flex;gap:12px;align-items:center">
                    <div style="width:48px;height:48px;border-radius:10px;background:${isActive ? "#10b981" : "#d1d5db"};display:flex;align-items:center;justify-content:center;font-size:22px">
                        ${device.icon || "⚙️"}
                    </div>
                    <div>
                        <div style="font-weight:600">${device.name}</div>
                        <div style="font-size:0.8rem;color:#6b7280">${zoneName}</div>
                    </div>
                </div>
                <span class="chip ${control.mode === "AUTO" ? "chip-success" : "chip-warning"}">${control.mode}</span>
            </div>
            <div style="display:grid;grid-template-columns:${technicianAutoOnly ? "1fr" : "1fr 1fr"};gap:8px;margin-bottom:12px">
                <button class="btn ${!isManual ? "btn-success" : "btn-outline"}"
                    onclick="window.setControlMode('${device.id}', 'AUTO')">⚡ Tự động</button>
                ${technicianAutoOnly ? "" : `<button class="btn ${isManual ? "btn-warning" : "btn-outline"}"
                    onclick="window.setControlMode('${device.id}', 'MANUAL')">✍️ Thủ công</button>
                `}
            </div>
            ${
              isManual && control.autoResetTime
                ? `
                <div class="warn-box" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
                    <span style="font-size:0.8rem;font-weight:600">
                        Tự động về AUTO sau: ${getTimeRemaining(new Date(control.autoResetTime))}
                    </span>
                    <button class="btn btn-outline btn-sm" onclick="window.resetToAuto('${device.id}')">
                        Trả về ngay
                    </button>
                </div>
            `
                : ""
            }
            <div style="margin-bottom:12px">
                <div style="font-size:0.85rem;color:#6b7280;margin-bottom:6px">
                    Công suất: ${control.valuePercent}%
                </div>
                <input type="range" class="slider" value="${control.valuePercent}" 
                       ${control.mode === "AUTO" || technicianAutoOnly ? "disabled" : ""} 
                       onchange="window.setControlValue('${device.id}', this.value)">
            </div>
            <button class="btn ${isActive ? "btn-error" : "btn-success"}" 
                    style="width:100%" ${isManual && !technicianAutoOnly ? "" : "disabled"} onclick="window.toggleDevice('${device.id}')">
                ${isActive ? "🔴 Tắt thiết bị" : "🟢 Bật thiết bị"}
            </button>
        </div>
    `;
    })
    .join("");
}

export async function renderControlPage() {
  const container = document.getElementById("page-control");
  if (!container) return;

  try {
    await loadControlData();
  } catch (err) {
    container.innerHTML = `<div class="card" style="padding:20px; text-align:center; color:#ef4444;">Lỗi tải dữ liệu: ${err.message}</div>`;
    return;
  }

  const greenhouses = getGreenhouses(zones);

  container.innerHTML = `
        <div class="page-header">
            <div>
                <div class="page-title">Bảng Điều khiển</div>
                <div class="page-sub">Điều khiển tự động và ghi đè thủ công</div>
            </div>
            <div style="display:flex; gap:12px; align-items:center;">
                <div>
                    <label style="font-size:0.85rem; color:#6b7280; margin-right:6px;">🏠 Nhà kính:</label>
                    <select id="greenhouse-filter" class="form-select" style="width:auto; display:inline-block;">
                        <option value="">-- Tất cả --</option>
                        ${greenhouses.map((gh) => `<option value="${gh.id}">${gh.name}</option>`).join("")}
                    </select>
                </div>
            </div>
        </div>
        <div class="grid grid-2" style="margin-bottom:20px">
            <div class="card" style="background:#f0fdf4;border-color:#bbf7d0">
                <div class="card-title">⚡ Chế độ Tự động</div>
                <p style="font-size:0.875rem;color:#6b7280;margin-bottom:12px">
                    Hệ thống Rule Engine tự động điều khiển thiết bị dựa trên công thức sinh trưởng 
                    và dữ liệu cảm biến thời gian thực.
                </p>
                <div style="background:white;border-radius:8px;padding:12px;border:1px solid rgba(0,0,0,0.08)">
                    <div style="font-size:0.75rem;color:#6b7280;margin-bottom:6px">Ví dụ luật tự động:</div>
                    <code style="font-size:0.82rem">
                        IF Nhiệt độ > Cấu hình + 2°C<br>
                        THEN Bật quạt thông gió & Phun sương
                    </code>
                </div>
            </div>
            <div class="card" style="background:#fffbeb;border-color:#fde68a">
                <div class="card-title">✍️ Chế độ Thủ công</div>
                <p style="font-size:0.875rem;color:#6b7280;margin-bottom:12px">
                    Ghi đè tạm thời để can thiệp khẩn cấp. Hệ thống sẽ tự động trở về chế độ AUTO sau 2 giờ.
                </p>
                <div style="background:white;border-radius:8px;padding:12px;border:1px solid rgba(0,0,0,0.08)">
                    <div style="font-size:0.75rem;color:#a16207;font-weight:600;margin-bottom:4px">⚠️ Lưu ý:</div>
                    <div style="font-size:0.82rem">Rule Engine sẽ bỏ qua thiết bị ở chế độ MANUAL</div>
                </div>
            </div>
        </div>
        <div class="grid grid-2" id="control-cards"></div>
    `;

  const filterSelect = document.getElementById("greenhouse-filter");
  filterSelect.addEventListener("change", (e) => {
    filterGreenhouseId = e.target.value || null;
    renderControls();
  });

  await renderControls();
}

// ===================== HÀM XỬ LÝ SỰ KIỆN =====================
export async function toggleControlMode(deviceId) {
  const device = devices.find((d) => String(d.id) === String(deviceId));
  if (!device) return;
  const control = controlProperties.find((cp) => String(cp.device_id) === String(deviceId));
  if (!control) return;

  let newMode, newAutoResetTime;
  if (control.mode === "AUTO") {
    newMode = "MANUAL";
    newAutoResetTime = new Date(Date.now() + 2 * 3600000);
    showToast("Chế độ thủ công sẽ tự động tắt sau 2 giờ", "info");
  } else {
    newMode = "AUTO";
    newAutoResetTime = null;
    showToast("Đã chuyển về chế độ tự động");
  }

  try {
    await updateControlProperty(deviceId, {
      mode: newMode,
      isActive: control.isActive,
      valuePercent: control.valuePercent,
      autoResetTime: newAutoResetTime
    });
    control.mode = newMode;
    control.autoResetTime = newAutoResetTime;
    renderControls();
  } catch (err) {
    showToast("Lỗi cập nhật: " + err.message, "error");
  }
}

export async function setControlMode(deviceId, newMode) {
  if (getCurrentUser()?.role === "TECHNICIAN" && newMode !== "AUTO") {
    showToast("Kỹ thuật viên chỉ được sử dụng chế độ tự động", "warning");
    return;
  }
  const control = controlProperties.find((cp) => String(cp.device_id) === String(deviceId));
  if (!control || control.mode === newMode) return;
  await toggleControlMode(deviceId);
}

export async function toggleDevice(deviceId) {
  const device = devices.find((d) => String(d.id) === String(deviceId));
  if (!device) return;
  const control = controlProperties.find((cp) => String(cp.device_id) === String(deviceId));
  if (!control) return;

  if (control.mode === "AUTO") {
    showToast("Vui lòng chuyển sang chế độ thủ công trước", "warning");
    return;
  }

  const newIsActive = !control.isActive;
  try {
    await updateControlProperty(deviceId, {
      mode: control.mode,
      isActive: newIsActive,
      valuePercent: control.valuePercent,
      autoResetTime: control.autoResetTime
    });
    control.isActive = newIsActive;
    showToast(`${newIsActive ? "Đã bật" : "Đã tắt"} ${device.name}`);
    renderControls();
  } catch (err) {
    showToast("Lỗi cập nhật: " + err.message, "error");
  }
}

export async function setControlValue(deviceId, value) {
  const control = controlProperties.find((cp) => String(cp.device_id) === String(deviceId));
  if (!control) return;
  if (control.mode !== "MANUAL") {
    showToast("Chỉ được chỉnh công suất ở chế độ thủ công", "warning");
    return;
  }

  const newVal = parseInt(value, 10);
  try {
    await updateControlProperty(deviceId, {
      mode: control.mode,
      isActive: control.isActive,
      valuePercent: newVal,
      autoResetTime: control.autoResetTime
    });
    control.valuePercent = newVal;
    renderControls();
  } catch (err) {
    showToast("Lỗi cập nhật: " + err.message, "error");
  }
}

export async function resetToAuto(deviceId) {
  const control = controlProperties.find((cp) => String(cp.device_id) === String(deviceId));
  if (!control) return;

  try {
    await updateControlProperty(deviceId, {
      mode: "AUTO",
      isActive: control.isActive,
      valuePercent: control.valuePercent,
      autoResetTime: null
    });
    control.mode = "AUTO";
    control.autoResetTime = null;
    showToast("Đã trả về chế độ tự động");
    renderControls();
  } catch (err) {
    showToast("Lỗi cập nhật: " + err.message, "error");
  }
}

// Expose global
window.toggleControlMode = toggleControlMode;
window.setControlMode = setControlMode;
window.toggleDevice = toggleDevice;
window.setControlValue = setControlValue;
window.resetToAuto = resetToAuto;
