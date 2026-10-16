package chat.honeyserve.live;

import android.webkit.CookieManager;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

final class LiveHttp {
    static final String ORIGIN = "https://honeyserve-elo.onrender.com";
    static class ApiException extends Exception {
        final int status;
        ApiException(int status, String message) { super(message); this.status = status; }
    }
    static JSONObject request(String path, JSONObject body) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(ORIGIN + path).openConnection();
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(20000);
        connection.setInstanceFollowRedirects(false);
        connection.setRequestProperty("Accept", "application/json");
        String cookie = CookieManager.getInstance().getCookie(ORIGIN);
        if (cookie != null) connection.setRequestProperty("Cookie", cookie);
        try {
            if (body != null) {
                connection.setRequestMethod("POST");
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json");
                byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
                connection.setFixedLengthStreamingMode(payload.length);
                try (var out = connection.getOutputStream()) { out.write(payload); }
            }
            int status = connection.getResponseCode();
            InputStream stream = status < 400 ? connection.getInputStream() : connection.getErrorStream();
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            if (stream != null) try (stream) {
                byte[] chunk = new byte[4096];
                int read;
                while ((read = stream.read(chunk)) != -1) {
                    bytes.write(chunk, 0, read);
                    if (bytes.size() > 262144) throw new Exception("서버 응답이 너무 큽니다.");
                }
            }
            JSONObject result;
            try { result = new JSONObject(bytes.toString(StandardCharsets.UTF_8.name())); }
            catch (Exception ignored) { throw new ApiException(status, "서버 응답 오류: " + status); }
            if (status < 200 || status >= 300) throw new ApiException(status, result.optString("message", result.optString("error", "연결 오류")));
            return result;
        } finally { connection.disconnect(); }
    }
}
