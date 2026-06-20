/**
 * growth.js
 * Quản lý Công thức sinh trưởng (Recipe), Giai đoạn (GrowthStage), Ngưỡng (Threshold).
 * Tuân theo ERD: Recipe (1) -> GrowthStage (N) -> Threshold (N)
 * Hỗ trợ: thêm, sửa, xóa, điều chỉnh chu kỳ (kéo dài stage).
 * Sử dụng API backend thay vì state.js.
 */

import { showToast, openModal, closeModal } from "./app.js";
import { escapeHtml } from "./utils.js";
import {
  getRecipes,
  createRecipe,
  updateRecipe,
  deleteRecipe,
  getStages,
  getThresholds,
  getZones,
  getAlerts,
  getSensorData,
  updateZoneCycle,
  createStage,
  updateStage,
  deleteStage
} from "./api.js";

// ===================== BIẾN TOÀN CỤC =====================
let recipes = [];
let growthZones = [];
let growthAlerts = [];
let growthSensorData = [];
const selectedZoneByRecipe = {};
const METRIC_LABELS = {
  Temperature: "Nhiệt độ (°C)",
  Humidity: "Độ ẩm không khí (%)",
  Light: "Ánh sáng (lux)",
  SoilHumidity: "Độ ẩm đất (%)",
  PH: "Độ pH",
  CO2: "CO2 (ppm)"
};

// ===================== LOAD DỮ LIỆU =====================
async function loadRecipes() {
  try {
    const [loadedRecipes, loadedZones, loadedAlerts, loadedSensorData] = await Promise.all([
      getRecipes(), getZones(), getAlerts(), getSensorData(null, 1000)
    ]);
    recipes = loadedRecipes;
    growthZones = loadedZones.filter((item) => item.type === "zone");
    growthAlerts = loadedAlerts;
    growthSensorData = loadedSensorData;
    await Promise.all(
      recipes.map(async (recipe) => {
        const stages = await getStages(recipe.id);
        await Promise.all(
          stages.map(async (stage) => {
            stage.thresholds = await getThresholds(stage.id);
          })
        );
        recipe.stages = stages;
      })
    );
    return recipes;
  } catch (err) {
    showToast("Lỗi tải công thức: " + err.message, "error");
    throw err;
  }
}

function getZoneCycle(recipe, zone) {
  if (!zone?.start_date || !recipe.stages?.length) return null;
  const startDate = new Date(`${zone.start_date}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const adjustmentDays = Math.max(0, Number(zone.cycle_adjustment_days) || 0);
  const currentDay = Math.max(0, Math.floor((today - startDate) / 86400000) + 1 - adjustmentDays);
  const totalDays = Math.max(...recipe.stages.map((stage) => Number(stage.end_day)));
  const currentStage = recipe.stages.find(
    (stage) => currentDay >= Number(stage.start_day) && currentDay <= Number(stage.end_day)
  );
  return { currentDay, totalDays, currentStage, progress: Math.min(100, Math.round(currentDay / totalDays * 100)) };
}

function latestMetricValues(zoneId) {
  const latest = {};
  growthSensorData.filter((row) => String(row.zoneId) === String(zoneId)).forEach((row) => {
    if (!latest[row.metricType] || new Date(row.timestamp) > new Date(latest[row.metricType].timestamp)) {
      latest[row.metricType] = row;
    }
  });
  return latest;
}

function renderZoneTracking(recipe) {
  const appliedZones = growthZones.filter((zone) => String(zone.recipe_id) === String(recipe.id));
  if (!appliedZones.length) return '<div class="form-helper" style="margin-top:16px">Chưa có khu vực áp dụng công thức này.</div>';
  const selectedId = selectedZoneByRecipe[recipe.id] || appliedZones[0].id;
  selectedZoneByRecipe[recipe.id] = selectedId;
  const zone = appliedZones.find((item) => String(item.id) === String(selectedId)) || appliedZones[0];
  const cycle = getZoneCycle(recipe, zone);
  const values = latestMetricValues(zone.id);
  const thresholds = cycle?.currentStage?.thresholds || [];
  const thresholdHtml = THRESHOLD_METRICS.map((metric) => {
    const threshold = thresholds.find((item) => item.metric_type === metric.key);
    const actual = values[metric.key]?.value;
    const hasValue = actual !== undefined && actual !== null;
    const inRange = hasValue && threshold && Number(actual) >= Number(threshold.min_value) && Number(actual) <= Number(threshold.max_value);
    return `<div class="card" style="padding:9px">
      <strong>${metric.label}</strong>: ${threshold ? `${threshold.min_value} - ${threshold.max_value} ${metric.unit}` : "Chưa cấu hình"}
      <div><span class="chip ${!hasValue ? "chip-default" : inRange ? "chip-success" : "chip-warning"}">
        ${!hasValue ? "Chưa có dữ liệu" : `${actual} ${metric.unit} · ${inRange ? "Đạt" : "Ngoài ngưỡng"}`}
      </span></div>
    </div>`;
  }).join("");
  const alerts = growthAlerts.filter((alert) => String(alert.zone_id) === String(zone.id) && alert.status !== "resolved");
  const alertHtml = alerts.length ? alerts.map((alert) => `<div class="warn-box" style="margin-bottom:6px"><strong>${escapeHtml(alert.title)}</strong><br>${escapeHtml(alert.description)}</div>`).join("") : '<div class="form-helper">Không có cảnh báo đang hoạt động.</div>';
  return `<div style="margin-top:18px;border-top:1px solid #e5e7eb;padding-top:14px">
    <div style="display:flex;justify-content:space-between;gap:10px;align-items:end;flex-wrap:wrap">
      <div class="form-group" style="margin:0;min-width:260px">
        <label class="form-label" for="recipe-zone-${recipe.id}">Khu vực đang áp dụng</label>
        <select class="form-select recipe-zone-select" id="recipe-zone-${recipe.id}" data-recipe-id="${recipe.id}">
          ${appliedZones.map((item) => `<option value="${item.id}" ${String(item.id) === String(zone.id) ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}
        </select>
      </div>
      <button class="btn btn-outline adjust-growth-cycle" data-zone-id="${zone.id}" data-zone-name="${escapeHtml(zone.name)}">Điều chỉnh chu kỳ</button>
    </div>
    ${cycle ? `<div style="margin:14px 0">
      <div style="display:flex;justify-content:space-between"><strong>${cycle.currentStage ? escapeHtml(cycle.currentStage.name) : "Ngoài chu kỳ"}</strong><span>Ngày ${Math.min(cycle.currentDay, cycle.totalDays)}/${cycle.totalDays} · ${cycle.progress}%</span></div>
      <div class="progress-bar"><div class="progress-fill" style="width:${cycle.progress}%"></div></div>
    </div>` : '<div class="form-helper">Khu vực chưa có ngày bắt đầu.</div>'}
    <div class="subtitle">6 điều kiện môi trường</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:8px">${thresholdHtml}</div>
    <div class="subtitle" style="margin-top:14px">Cảnh báo khu vực</div>${alertHtml}
  </div>`;
}

// ===================== RENDER DANH SÁCH =====================

export async function renderGrowth() {
  const container = document.getElementById("growth-list");
  if (!container) return;

  if (recipes.length === 0) {
    container.innerHTML =
      '<div class="card" style="padding:20px; text-align:center;">Chưa có công thức nào. Hãy tạo mới.</div>';
    return;
  }

  container.innerHTML = recipes
    .map((recipe) => {
      const stagesHtml = recipe.stages
        .map((stage, idx) => {
          const thresholdsHtml = (stage.thresholds || [])
            .map(
              (th) =>
                `<span class="chip chip-default" style="font-size:0.7rem">
                    ${escapeHtml(METRIC_LABELS[th.metric_type] || th.metric_type)}: ${th.min_value} - ${th.max_value}
                </span>`
            )
            .join("");

          return `
                <div class="stage-card">
                    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px">
                        <div style="font-weight:600;font-size:0.875rem">${idx + 1}. ${escapeHtml(stage.name)}</div>
                    </div>
                    <div style="font-size:0.78rem;color:#6b7280;margin-bottom:6px">
                        Ngày ${stage.start_day} - ${stage.end_day}
                    </div>
                    <div style="display:flex;gap:4px;flex-wrap:wrap">${thresholdsHtml}</div>
                </div>
            `;
        })
        .join("");

      return `
            <div class="card" style="margin-bottom:16px" data-id="${recipe.id}">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;flex-wrap:wrap;gap:10px">
                    <div style="display:flex;gap:12px;align-items:flex-start">
                        <div style="width:56px;height:56px;border-radius:12px;background:#10b98120;display:flex;align-items:center;justify-content:center;font-size:26px;">🌿</div>
                        <div>
                            <div style="font-size:1.05rem;font-weight:600;margin-bottom:6px">${escapeHtml(recipe.name)}</div>
                            <div style="display:flex;gap:6px;flex-wrap:wrap">
                                <span class="chip chip-outlined-primary">${escapeHtml(recipe.flower_type)}</span>
                                <span class="chip chip-default">${escapeHtml(recipe.creator_name || "Kỹ thuật viên")}</span>
                            </div>
                        </div>
                    </div>
                    <div style="display:flex;gap:8px;align-items:center">
                        <button class="btn-icon edit-btn" data-id="${recipe.id}" title="Sửa">✏️</button>
                        <button class="btn-icon delete-btn" data-id="${recipe.id}" title="Xóa">🗑️</button>
                    </div>
                </div>
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px">${stagesHtml}</div>
                ${recipe.description ? `<div style="margin-top:12px;font-size:0.82rem;color:#6b7280">${escapeHtml(recipe.description)}</div>` : ""}
                ${renderZoneTracking(recipe)}
            </div>
        `;
    })
    .join("");

  // Gắn sự kiện (Đã cập nhật gọi hàm handleDeleteRecipe)
  document.querySelectorAll(".edit-btn").forEach((btn) => {
    btn.onclick = () => editRecipe(btn.dataset.id);
  });
  document.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.onclick = () => handleDeleteRecipe(btn.dataset.id);
  });
  document.querySelectorAll(".recipe-zone-select").forEach((select) => {
    select.onchange = () => {
      selectedZoneByRecipe[select.dataset.recipeId] = select.value;
      renderGrowth();
    };
  });
  document.querySelectorAll(".adjust-growth-cycle").forEach((button) => {
    button.onclick = () => openCycleAdjustmentModal(button.dataset.zoneId, button.dataset.zoneName);
  });
}

function openCycleAdjustmentModal(zoneId, zoneName) {
  const zone = growthZones.find((item) => String(item.id) === String(zoneId));
  if (!zone) return;
  document.getElementById("growth-cycle-modal")?.remove();
  document.body.insertAdjacentHTML("beforeend", `<div class="modal-overlay" id="growth-cycle-modal">
    <div class="modal" style="width:460px;max-width:95vw">
      <div class="modal-title">Điều chỉnh chu kỳ - ${escapeHtml(zoneName)}</div>
      <div class="form-group"><label class="form-label" for="growth-adjustment-days">Số ngày điều chỉnh</label>
        <input class="form-input" id="growth-adjustment-days" type="number" min="0" max="365" value="${Number(zone.cycle_adjustment_days) || 0}"></div>
      <div class="form-group"><label class="form-label" for="growth-adjustment-reason">Lý do</label>
        <textarea class="form-input" id="growth-adjustment-reason" rows="3" placeholder="Nhập lý do điều chỉnh">${escapeHtml(zone.adjustment_reason || "")}</textarea></div>
      <div class="modal-actions"><button class="btn btn-outline" id="cancel-growth-cycle">Hủy</button><button class="btn btn-primary" id="save-growth-cycle">Lưu</button></div>
    </div></div>`);
  const modal = document.getElementById("growth-cycle-modal");
  openModal("growth-cycle-modal");
  document.getElementById("cancel-growth-cycle").onclick = () => modal.remove();
  document.getElementById("save-growth-cycle").onclick = async () => {
    const days = Number(document.getElementById("growth-adjustment-days").value);
    const reason = document.getElementById("growth-adjustment-reason").value.trim();
    if (!Number.isInteger(days) || days < 0 || days > 365 || !reason) return showToast("Nhập số ngày 0-365 và lý do điều chỉnh", "warning");
    try {
      await updateZoneCycle(zoneId, days, reason);
      modal.remove();
      await loadRecipes();
      await renderGrowth();
      showToast("Đã điều chỉnh chu kỳ khu vực", "success");
    } catch (err) { showToast("Lỗi điều chỉnh chu kỳ: " + err.message, "error"); }
  };
}

// ===================== XÓA CÔNG THỨC (Đã đổi tên) =====================
async function handleDeleteRecipe(id) {
  if (confirm("Bạn có chắc chắn muốn xóa công thức này?")) {
    try {
      await deleteRecipe(id); // Gọi hàm xóa từ api.js
      recipes = recipes.filter((r) => String(r.id) !== String(id));
      await renderGrowth();
      showToast("Đã xóa công thức", "info");
    } catch (err) {
      showToast("Lỗi xóa công thức: " + err.message, "error");
    }
  }
}

// ===================== SỬA CÔNG THỨC =====================
function editRecipe(id) {
  const recipe = recipes.find((r) => String(r.id) === String(id));
  if (recipe) openRecipeModal(recipe);
  else showToast("Không tìm thấy công thức", "error");
}

// ===================== THÊM / SỬA CÔNG THỨC (MODAL) =====================
let tempStages = [];
let editingRecipeId = null;
const THRESHOLD_METRICS = [
  { key: "Temperature", label: "Nhiệt độ", unit: "°C" },
  { key: "Humidity", label: "Độ ẩm không khí", unit: "%" },
  { key: "Light", label: "Cường độ ánh sáng", unit: "lux" },
  { key: "SoilHumidity", label: "Độ ẩm đất", unit: "%" },
  { key: "PH", label: "Độ pH", unit: "pH" },
  { key: "CO2", label: "Nồng độ CO2", unit: "ppm" }
];

function thresholdValue(stage, metric, field) {
  const threshold = (stage.thresholds || []).find((item) => item.metric_type === metric);
  return threshold?.[field] ?? "";
}

function renderStageInputs() {
  const container = document.getElementById("stages-container");
  if (!container) return;
  container.innerHTML = tempStages
    .map(
      (stage, idx) => `
        <div class="stage-row" style="border:1px solid #e5e7eb; padding:12px; margin-bottom:8px; border-radius:8px;">
            <div style="display:flex; gap:8px; margin-bottom:8px; flex-wrap:wrap;">
                <div style="flex:2; min-width:120px;">
                    <label>Tên giai đoạn</label>
                    <input class="form-input stage-name" data-idx="${idx}" value="${escapeHtml(stage.name)}" placeholder="Tên giai đoạn">
                </div>
                <div style="flex:1; min-width:80px;">
                    <label>Ngày bắt đầu</label>
                    <input class="form-input stage-start" data-idx="${idx}" type="number" min="1" value="${stage.start_day}">
                </div>
                <div style="flex:1; min-width:80px;">
                    <label>Ngày kết thúc</label>
                    <input class="form-input stage-end" data-idx="${idx}" type="number" min="1" value="${stage.end_day}">
                </div>
                <div style="flex:1; min-width:100px;">
                    <button class="btn-icon remove-stage" data-idx="${idx}" style="margin-top:24px;">🗑️</button>
                </div>
            </div>
            <div style="margin-top:10px">
                <label style="font-weight:600">Điều kiện môi trường</label>
                <div style="display:grid;grid-template-columns:minmax(150px,2fr) 1fr 1fr;gap:6px;align-items:center;margin-top:6px">
                    <span></span><small>Min</small><small>Max</small>
                    ${THRESHOLD_METRICS.map((metric) => `
                        <span>${metric.label} (${metric.unit})</span>
                        <input class="form-input threshold-value" type="number" step="any" data-idx="${idx}" data-metric="${metric.key}" data-field="min_value" value="${thresholdValue(stage, metric.key, "min_value")}" required>
                        <input class="form-input threshold-value" type="number" step="any" data-idx="${idx}" data-metric="${metric.key}" data-field="max_value" value="${thresholdValue(stage, metric.key, "max_value")}" required>
                    `).join("")}
                </div>
            </div>
        </div>
    `
    )
    .join("");

  // Cập nhật tempStages khi thay đổi
  document.querySelectorAll(".stage-name").forEach((inp) => {
    inp.oninput = (e) => {
      tempStages[e.target.dataset.idx].name = e.target.value;
    };
  });
  document.querySelectorAll(".stage-start").forEach((inp) => {
    inp.oninput = (e) => {
      tempStages[e.target.dataset.idx].start_day = parseInt(e.target.value) || 1;
    };
  });
  document.querySelectorAll(".stage-end").forEach((inp) => {
    inp.oninput = (e) => {
      tempStages[e.target.dataset.idx].end_day = parseInt(e.target.value) || 1;
    };
  });
  document.querySelectorAll(".threshold-value").forEach((inp) => {
    inp.oninput = (e) => {
      const { idx, metric, field } = e.target.dataset;
      const stage = tempStages[idx];
      let threshold = stage.thresholds.find((item) => item.metric_type === metric);
      if (!threshold) {
        threshold = { metric_type: metric, min_value: "", max_value: "" };
        stage.thresholds.push(threshold);
      }
      threshold[field] = e.target.value === "" ? "" : Number(e.target.value);
    };
  });
  document.querySelectorAll(".remove-stage").forEach((btn) => {
    btn.onclick = () => {
      const idx = parseInt(btn.dataset.idx);
      tempStages.splice(idx, 1);
      renderStageInputs();
    };
  });
}

function openRecipeModal(editData = null) {
  if (editData) {
    editingRecipeId = editData.id;
    tempStages = editData.stages.map((s) => ({
      ...s,
      thresholds: s.thresholds || []
    }));
  } else {
    editingRecipeId = null;
    tempStages = [
      {
        name: "",
        start_day: 1,
        end_day: 10,
        thresholds: []
      }
    ];
  }

  const modalTitle = editData ? "✏️ Chỉnh sửa công thức" : "🌱 Tạo công thức sinh trưởng mới";
  const nameValue = editData ? editData.name : "";
  const flowerValue = editData ? editData.flower_type : "";
  const descValue = editData ? editData.description : "";

  const modalHtml = `
        <div class="modal-overlay" id="recipe-modal">
            <div class="modal" style="width: 800px; max-width: 95vw; max-height: 85vh; display: flex; flex-direction: column;">
                <div class="modal-title">${modalTitle}</div>
                <div style="flex: 1; overflow-y: auto; padding-right: 5px;">
                    <div class="form-group">
                        <label class="form-label">Tên công thức</label>
                        <input class="form-input" id="recipe-name" value="${escapeHtml(nameValue)}" placeholder="VD: Công thức Hoa Hồng">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Loại hoa</label>
                        <input class="form-input" id="recipe-flower" value="${escapeHtml(flowerValue)}" placeholder="Hoa Hồng, Hoa Cúc, ...">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Mô tả</label>
                        <input class="form-input" id="recipe-desc" value="${escapeHtml(descValue)}" placeholder="Mô tả công thức">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Các giai đoạn</label>
                        <div id="stages-container"></div>
                        <button type="button" class="btn btn-outline btn-sm" id="add-stage-btn" style="margin-top:8px;">+ Thêm giai đoạn</button>
                    </div>
                </div>
                <div class="modal-actions" style="margin-top: 16px;">
                    <button class="btn btn-outline" id="cancel-recipe">Hủy</button>
                    <button class="btn btn-primary" id="save-recipe">Lưu</button>
                </div>
            </div>
        </div>
    `;
  document.body.insertAdjacentHTML("beforeend", modalHtml);
  renderStageInputs();
  openModal("recipe-modal");

  document.getElementById("add-stage-btn").onclick = () => {
    tempStages.push({
      name: "",
      start_day: 1,
      end_day: 10,
      thresholds: []
    });
    renderStageInputs();
  };
  document.getElementById("cancel-recipe").onclick = () => {
    closeModal("recipe-modal");
    document.getElementById("recipe-modal").remove();
  };
  document.getElementById("save-recipe").onclick = async () => {
    const name = document.getElementById("recipe-name").value.trim();
    const flower_type = document.getElementById("recipe-flower").value.trim();
    const description = document.getElementById("recipe-desc").value.trim();
    if (!name || !flower_type) {
      showToast("Vui lòng nhập tên công thức và loại hoa", "warning");
      return;
    }
    if (tempStages.length === 0) {
      showToast("Cần ít nhất một giai đoạn", "warning");
      return;
    }
    for (let i = 0; i < tempStages.length; i++) {
      if (!tempStages[i].name.trim()) {
        showToast(`Giai đoạn ${i + 1} chưa có tên`, "warning");
        return;
      }
      if (tempStages[i].start_day > tempStages[i].end_day) {
        showToast(`Giai đoạn ${i + 1}: ngày bắt đầu không được lớn hơn ngày kết thúc`, "warning");
        return;
      }
      if (i > 0 && tempStages[i].start_day <= tempStages[i - 1].end_day) {
        showToast(`Giai đoạn ${i + 1} đang chồng thời gian với giai đoạn trước`, "warning");
        return;
      }
      if (tempStages[i].thresholds.length !== THRESHOLD_METRICS.length ||
          tempStages[i].thresholds.some((item) => item.min_value === "" || item.max_value === "")) {
        showToast(`Giai đoạn ${i + 1}: cần nhập đủ Min/Max cho 6 điều kiện`, "warning");
        return;
      }
      if (tempStages[i].thresholds.some((item) => Number(item.min_value) > Number(item.max_value))) {
        showToast(`Giai đoạn ${i + 1}: giá trị Min không được lớn hơn Max`, "warning");
        return;
      }
    }
    const stages = tempStages.map((s) => ({
      id: s.id || null,
      name: s.name,
      start_day: s.start_day,
      end_day: s.end_day,
      thresholds: s.thresholds || []
    }));

    try {
      let recipeId;
      if (editingRecipeId) {
        // Cập nhật recipe
        await updateRecipe(editingRecipeId, {
          name,
          flower_type,
          description
        });
        recipeId = editingRecipeId;
        const savedStageIds = new Set(stages.filter((stage) => stage.id).map((stage) => stage.id));
        for (const oldStage of editData.stages) {
          if (!savedStageIds.has(oldStage.id)) await deleteStage(oldStage.id);
        }
      } else {
        // Thêm mới recipe
        const newRecipe = await createRecipe({
          name,
          flower_type,
          description
        });
        recipeId = newRecipe.id;
        recipes.push(newRecipe);
      }

      for (const stage of stages) {
        if (stage.id) await updateStage(stage.id, stage);
        else await createStage(recipeId, stage);
      }

      closeModal("recipe-modal");
      document.getElementById("recipe-modal").remove();
      // Reload data
      await loadRecipes();
      await renderGrowth();
      showToast(editingRecipeId ? "Đã cập nhật công thức" : "Đã thêm công thức mới", "success");
    } catch (err) {
      showToast("Lỗi lưu: " + err.message, "error");
    }
  };
}

// ===================== RENDER TOÀN BỘ TRANG =====================
export async function renderGrowthPage() {
  const container = document.getElementById("page-growth");
  if (!container) return;

  try {
    await loadRecipes();
  } catch (err) {
    container.innerHTML = `<div class="card" style="padding:20px; text-align:center; color:#ef4444;">Lỗi tải dữ liệu: ${err.message}</div>`;
    return;
  }

  container.innerHTML = `
        <div class="page-header">
            <div>
                <div class="page-title">Chu kỳ Sinh trưởng</div>
                <div class="page-sub">Quản lý công thức, giai đoạn và ngưỡng điều kiện</div>
            </div>
            <button class="btn btn-primary" id="add-recipe-btn" title="Tạo công thức sinh trưởng mới">🌱 Tạo công thức mới</button>
        </div>
        <div id="growth-list"></div>
    `;

  await renderGrowth();
  document.getElementById("add-recipe-btn").onclick = () => openRecipeModal(null);
}
