/**
 * login.js
 * Render biểu mẫu đăng nhập và chuyển hướng sau khi xác thực thành công.
 */

import { login } from "../auth.js";
import { showToast } from "../app.js";
import { forgotPassword } from "../api.js";

function openForgotPasswordModal() {
  document.getElementById("forgot-password-modal")?.remove();
  document.body.insertAdjacentHTML("beforeend", `
    <div class="modal-overlay" id="forgot-password-modal">
      <div class="modal" style="width:430px;max-width:95vw">
        <div class="modal-title">Quên mật khẩu</div>
        <div class="form-group">
          <label class="form-label" for="forgot-identifier">Tên đăng nhập / Email</label>
          <input class="form-input" id="forgot-identifier" autocomplete="username"
            placeholder="Nhập tên đăng nhập hoặc email" title="Tên đăng nhập hoặc email của tài khoản">
        </div>
        <div class="form-group">
          <label class="form-label" for="forgot-phone">Số điện thoại xác minh</label>
          <input class="form-input" id="forgot-phone" type="tel" autocomplete="tel"
            placeholder="Nhập số điện thoại đã đăng ký" title="Số điện thoại xác minh tài khoản">
        </div>
        <div class="form-group">
          <label class="form-label" for="forgot-new-password">Mật khẩu mới</label>
          <input class="form-input" id="forgot-new-password" type="password" autocomplete="new-password"
            placeholder="Nhập mật khẩu mới, tối thiểu 6 ký tự" title="Mật khẩu mới">
        </div>
        <div class="form-group">
          <label class="form-label" for="forgot-confirm-password">Nhập lại mật khẩu mới</label>
          <input class="form-input" id="forgot-confirm-password" type="password" autocomplete="new-password"
            placeholder="Nhập lại mật khẩu mới" title="Xác nhận mật khẩu mới">
        </div>
        <div class="modal-actions">
          <button class="btn btn-outline" id="cancel-forgot-password">Hủy</button>
          <button class="btn btn-primary" id="save-forgot-password">Đặt lại mật khẩu</button>
        </div>
      </div>
    </div>`);

  const modal = document.getElementById("forgot-password-modal");
  document.getElementById("cancel-forgot-password").onclick = () => modal.remove();
  document.getElementById("save-forgot-password").onclick = async () => {
    const identifier = document.getElementById("forgot-identifier").value.trim();
    const phone = document.getElementById("forgot-phone").value.trim();
    const newPassword = document.getElementById("forgot-new-password").value;
    const confirmPassword = document.getElementById("forgot-confirm-password").value;
    if (!identifier || !phone || !newPassword || !confirmPassword) {
      return showToast("Vui lòng nhập đầy đủ thông tin", "warning");
    }
    try {
      await forgotPassword(identifier, phone, newPassword, confirmPassword);
      modal.remove();
      showToast("Đặt lại mật khẩu thành công. Hãy đăng nhập lại.", "success");
    } catch (err) {
      showToast(err.message, "error");
    }
  };
}

export function renderLoginPage() {
  const container = document.getElementById("page-login");
  container.innerHTML = `
        <div style="display:flex; justify-content:center; align-items:center; min-height:80vh;">
            <div class="card" style="width:400px;">
                <div class="card-title" style="text-align:center">🔐 Đăng nhập</div>
                <div class="form-group">
                    <label class="form-label" for="login-username">Tên đăng nhập / Email</label>
                    <input class="form-input" id="login-username" type="text" placeholder="Nhập tài khoản hoặc email">
                </div>
                <div class="form-group">
                    <label class="form-label" for="login-password">Mật khẩu</label>
                    <input class="form-input" id="login-password" type="password" placeholder="Nhập mật khẩu">
                </div>
                <div class="modal-actions" style="justify-content:space-between">
                    <button class="btn btn-outline" id="goto-register">Đăng ký</button>
                    <button class="btn btn-primary" id="login-btn">Đăng nhập</button>
                </div>
                <button class="btn" id="forgot-password-btn" style="width:100%;margin-top:8px;color:#2563eb">Quên mật khẩu?</button>
            </div>
        </div>
    `;
  document.getElementById("login-btn").onclick = async () => {
    const username = document.getElementById("login-username").value.trim();
    const password = document.getElementById("login-password").value;
    if (!username || !password) return showToast("Nhập đầy đủ", "warning");
    try {
      await login(username, password);
      showToast("Đăng nhập thành công", "success");
      window.location.hash = "dashboard";
      window.dispatchEvent(new Event("auth-changed"));
    } catch (err) {
      showToast(err.message, "error");
    }
  };
  document.getElementById("goto-register").onclick = () => {
    window.location.hash = "register";
    window.dispatchEvent(new Event("auth-changed"));
  };
  document.getElementById("forgot-password-btn").onclick = openForgotPasswordModal;
}
