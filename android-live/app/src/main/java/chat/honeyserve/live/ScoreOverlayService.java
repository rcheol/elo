package chat.honeyserve.live;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class ScoreOverlayService extends Service {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private WindowManager window;
    private LinearLayout panel;
    private TextView title, positions;
    private Button a, b, undo, end;
    private JSONObject session;
    private JSONArray pending = new JSONArray();
    private SharedPreferences prefs;
    private boolean inFlight, blocked, destroyed;
    private final Runnable tick = this::sync;

    @Override public void onCreate() {
        super.onCreate();
        prefs = getSharedPreferences("live-queue", MODE_PRIVATE);
        var manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel("scoring", "경기 점수 리모컨", NotificationManager.IMPORTANCE_LOW));
        PendingIntent close = PendingIntent.getService(this, 2, new Intent(this, ScoreOverlayService.class).setAction("close"), PendingIntent.FLAG_IMMUTABLE);
        PendingIntent open = PendingIntent.getActivity(this, 1, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new Notification.Builder(this, "scoring").setContentTitle("허니서브 점수 리모컨")
            .setContentText("PRISM 위에서 점수를 기록하는 중").setSmallIcon(android.R.drawable.ic_menu_edit)
            .setOngoing(true).setContentIntent(open).addAction(android.R.drawable.ic_menu_close_clear_cancel, "리모컨 닫기", close).build();
        startForeground(1, notification);
        window = getSystemService(WindowManager.class);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || "close".equals(intent.getAction())) { stopSelf(); return START_NOT_STICKY; }
        try {
            JSONObject next = new JSONObject(intent.getStringExtra("session"));
            String savedId = prefs.getString("sessionId", "");
            JSONArray saved = new JSONArray(prefs.getString("pending", "[]"));
            if (saved.length() > 0 && !savedId.equals(next.getString("id"))) {
                throw new Exception("다른 경기의 미전송 득점이 남아 있습니다. 해당 경기를 먼저 확인하세요.");
            }
            session = next; pending = saved;
            blocked = prefs.getBoolean("blocked", false) && saved.length() > 0;
            if (panel == null) createPanel();
            draw(); sync();
        } catch (Exception error) {
            android.widget.Toast.makeText(this, error.getMessage(), android.widget.Toast.LENGTH_LONG).show(); stopSelf();
        }
        return START_NOT_STICKY;
    }

    private int dp(int n) { return Math.round(n * getResources().getDisplayMetrics().density); }
    private Button button(String label, LinearLayout row, Runnable action) {
        Button button = new Button(this); button.setText(label); button.setTextSize(14);
        row.addView(button, new LinearLayout.LayoutParams(0, dp(48), 1));
        button.setOnClickListener(v -> action.run()); return button;
    }
    private void createPanel() {
        panel = new LinearLayout(this); panel.setOrientation(LinearLayout.VERTICAL); panel.setPadding(dp(6), dp(6), dp(6), dp(6));
        panel.setBackgroundColor(Color.rgb(241, 247, 243));
        title = new TextView(this); title.setTextSize(13); title.setPadding(dp(8), dp(8), dp(8), dp(8)); panel.addView(title);
        var params = new WindowManager.LayoutParams(dp(276), -2, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE, PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.LEFT; params.x = dp(12); params.y = dp(80);
        title.setOnTouchListener(new android.view.View.OnTouchListener() {
            float x, y; int ox, oy;
            @Override public boolean onTouch(android.view.View view, MotionEvent event) {
                if (event.getAction() == MotionEvent.ACTION_DOWN) { x = event.getRawX(); y = event.getRawY(); ox = params.x; oy = params.y; return true; }
                if (event.getAction() == MotionEvent.ACTION_MOVE) {
                    var bounds = getResources().getDisplayMetrics();
                    params.x = Math.max(0, Math.min(bounds.widthPixels - panel.getWidth(), ox + (int)(event.getRawX() - x)));
                    params.y = Math.max(0, Math.min(bounds.heightPixels - panel.getHeight(), oy + (int)(event.getRawY() - y)));
                    window.updateViewLayout(panel, params); return true;
                }
                if (event.getAction() == MotionEvent.ACTION_UP) { view.performClick(); return true; }
                return false;
            }
        });
        LinearLayout scores = new LinearLayout(this); panel.addView(scores);
        a = button("A +1", scores, () -> enqueue("point", "A"));
        b = button("B +1", scores, () -> enqueue("point", "B"));
        positions = new TextView(this); positions.setTextSize(12); positions.setPadding(dp(6), dp(4), dp(6), dp(4)); panel.addView(positions);
        LinearLayout actions = new LinearLayout(this); panel.addView(actions);
        undo = button("↶", actions, () -> enqueue("undo", null)); undo.setContentDescription("마지막 조작 되돌리기");
        end = button("종료", actions, () -> {
            if (pending.length() != 0) { title.setText("미전송 득점을 먼저 동기화하세요."); return; }
            if ("ready".equals(session.optString("status"))) { enqueue("start", null); return; }
            startActivity(new Intent(this, MainActivity.class).putExtra("finish", true).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP));
            stopSelf();
        });
        Button close = button("×", actions, this::stopSelf); close.setContentDescription("리모컨 닫기");
        Button resolve = new Button(this); resolve.setText("동기화 충돌 확인"); resolve.setTextSize(12); panel.addView(resolve);
        resolve.setOnClickListener(v -> {
            if (!blocked) { title.setText("미전송 " + pending.length() + "개 · 자동 재시도 중"); return; }
            // A service dialog needs its own overlay window, just like the remote panel.
            var dialog = new android.app.AlertDialog.Builder(new android.view.ContextThemeWrapper(this, android.R.style.Theme_Material_Light_Dialog_Alert))
                .setTitle("동기화 충돌")
                .setMessage("서버 점수를 확인한 뒤 미전송 조작 " + pending.length() + "개를 버릴까요?\nA " + session.optInt("scoreA") + " : " + session.optInt("scoreB") + " B\n전송된 점수는 유지됩니다.")
                .setPositiveButton("미전송 조작 버리기", (d, w) -> { pending = new JSONArray(); blocked = false; persist(); sync(); })
                .setNegativeButton("유지", null).create();
            dialog.getWindow().setType(WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY); dialog.show();
        });
        window.addView(panel, params);
    }

    private void enqueue(String type, String team) {
        boolean starting = "start".equals(type) && "ready".equals(session.optString("status"));
        if (blocked || (!starting && !"live".equals(session.optString("status"))) || pending.length() >= 200) return;
        try {
            JSONObject command = new JSONObject().put("type", type).put("operationId", UUID.randomUUID().toString())
                .put("expectedRevision", pending.length() == 0 ? session.getInt("revision") : pending.getJSONObject(pending.length() - 1).getInt("expectedRevision") + 1)
                .put("capturedAt", System.currentTimeMillis());
            if (team != null) command.put("team", team);
            pending.put(command); persist(); draw(); sync();
        } catch (Exception error) { title.setText(error.getMessage()); }
    }
    private void persist() {
        // Commit before sending, so a process kill cannot turn a retry into a new point.
        if (!prefs.edit().putString("sessionId", session.optString("id")).putString("pending", pending.toString()).putBoolean("blocked", blocked).commit()) {
            blocked = true; title.setText("휴대폰 저장 실패 · 득점 전송을 중단합니다.");
        }
    }
    private String name(String id) {
        JSONArray players = session.optJSONArray("players");
        if (players != null) for (int i = 0; i < players.length(); i++) {
            JSONObject p = players.optJSONObject(i); if (p != null && id.equals(p.optString("id"))) return p.optString("name");
        }
        return "";
    }
    private void draw() {
        if (panel == null) return;
        title.setText(blocked ? "동기화 확인 필요 · 미전송 " + pending.length() : "허니서브 · 미전송 " + pending.length());
        a.setText("A " + session.optInt("scoreA") + "  +1"); b.setText("B " + session.optInt("scoreB") + "  +1");
        boolean active = "live".equals(session.optString("status"));
        a.setEnabled(!blocked && active); b.setEnabled(!blocked && active); undo.setEnabled(!blocked && active);
        end.setEnabled(!blocked && pending.length() == 0);
        end.setText("ready".equals(session.optString("status")) ? "시작" : "종료");
        try {
            String near = session.getString("nearTeam"); String far = near.equals("A") ? "B" : "A";
            JSONObject p = session.getJSONObject("positions"); JSONArray nearP = p.getJSONArray(near), farP = p.getJSONArray(far);
            positions.setText("서브 " + name(session.getString("serverId")) + " · " + (session.getString("serviceSide").equals("right") ? "오른쪽" : "왼쪽")
                + "\n먼 코트 " + name(farP.getString(1)) + " | " + name(farP.getString(0))
                + "\n가까운 코트 " + name(nearP.getString(0)) + " | " + name(nearP.getString(1)));
        } catch (Exception ignored) { positions.setText("위치 확인 중"); }
    }
    private void sync() {
        handler.removeCallbacks(tick);
        if (inFlight || destroyed || session == null) return;
        inFlight = true;
        JSONObject command = blocked ? null : pending.optJSONObject(0);
        String path = "/api/live/sessions/" + session.optString("id") + (command == null ? "?compact=1" : "/commands?compact=1");
        network.execute(() -> {
            try {
                JSONObject result = LiveHttp.request(path, command);
                handler.post(() -> {
                    if (destroyed) return;
                    session = result;
                    if (command != null) { pending.remove(0); persist(); }
                    inFlight = false; draw();
                    if (("finished".equals(session.optString("status")) || "cancelled".equals(session.optString("status"))) && pending.length() == 0) { stopSelf(); return; }
                    handler.postDelayed(tick, pending.length() > 0 && !blocked ? 100 : 5000);
                });
            } catch (Exception error) {
                handler.post(() -> {
                    if (destroyed) return;
                    inFlight = false;
                    if (error instanceof LiveHttp.ApiException e && e.status >= 400 && e.status < 500) { blocked = true; persist(); }
                    draw(); title.setText("미전송 " + pending.length() + " · " + error.getMessage());
                    handler.postDelayed(tick, 10000);
                });
            }
        });
    }
    @Override public void onDestroy() {
        destroyed = true; handler.removeCallbacksAndMessages(null);
        if (panel != null) window.removeView(panel);
        network.shutdownNow(); stopForeground(STOP_FOREGROUND_REMOVE); super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
