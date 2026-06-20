/**
 * register.js
 * Render biểu mẫu đăng ký và gửi tài khoản mới vào hàng chờ phê duyệt.
 */

import { register } from "../auth.js";
import { showToast } from "../app.js";

export function renderRegisterPage() {
  const container = document.getElementById("page-register");
  container.innerHTML = `
        <div style="display:flex; justify-content:center; align-items:center; min-height:80vh;">
            <div class="card" style="width:450px;">
                <div class="card-title" style="text-align:center">📝 Đăng ký</div>
                <div class="form-group">
                    <label class="form-label" for="reg-username">Tên đăng nhập</label>
                    <input class="form-input" id="reg-username" placeholder="Nhập tên đăng nhập">
                </div>
                <div class="form-group">
                    <label class="form-label" for="reg-email">Email</label>
                    <input class="form-input" id="reg-email" type="email" placeholder="Nhập địa chỉ email">
                </div>
                <div class="form-group">
                    <label class="form-label" for="reg-phone">Số điện thoại</label>
                    <input class="form-input" id="reg-phone" placeholder="Nhập số điện thoại">
                </div>
                <div class="form-group">
                    <label class="form-label" for="reg-password">Mật khẩu</label>
                    <input class="form-input" id="reg-password" type="password" placeholder="Nhập mật khẩu">
                </div>
                <div class="form-group">
                    <label class="form-label" for="reg-confirm">Xác nhận mật khẩu</label>
                    <input class="form-input" id="reg-confirm" type="password" placeholder="Nhập lại mật khẩu">
                </div>
                <div class="form-group">
                    <label class="form-label" for="reg-role">Vai trò</label>
                    <select class="form-select" id="reg-role">
                        <option value="OPERATOR">Nhân viên vận hành</option>
                        <option value="TECHNICIAN">Kỹ thuật viên</option>
                        <option value="OWNER">Chủ trang trại</option>
                    </select>
                </div>
                <div class="modal-actions" style="justify-content:space-between">
                    <button class="btn btn-outline" id="back-login">← Quay lại</button>
                    <button class="btn btn-primary" id="register-btn">Đăng ký</button>
                </div>
            </div>
        </div>
    `;
  document.getElementById("register-btn").onclick = async () => {
    const username = document.getElementById("reg-username").value.trim();
    const email = document.getElementById("reg-email").value.trim();
    const phone = document.getElementById("reg-phone").value.trim();
    const password = document.getElementById("reg-password").value;
    const confirm = document.getElementById("reg-confirm").value;
    const role = document.getElementById("reg-role").value;
    if (!username || !email || !phone || !password)
      return showToast("Nhập đủ thông tin", "warning");
    if (password !== confirm) return showToast("Mật khẩu không khớp", "warning");
    try {
      await register({ username, email, phone, password, role });
      showToast("Đăng ký thành công! Tài khoản đang chờ chủ trang trại phê duyệt.", "info");
      setTimeout(() => {
        window.location.hash = "login";
        window.dispatchEvent(new Event("auth-changed"));
      }, 3000);
    } catch (err) {
      showToast(err.message, "error");
    }
  };
  document.getElementById("back-login").onclick = () => {
    window.location.hash = "login";
    window.dispatchEvent(new Event("auth-changed"));
  };
}
