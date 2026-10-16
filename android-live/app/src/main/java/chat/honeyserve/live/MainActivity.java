package chat.honeyserve.live;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebChromeClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.Toast;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
    private WebView web;
    private Button remote;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets;
        });
        LinearLayout toolbar = new LinearLayout(this);
        remote = new Button(this); remote.setText("점수 리모컨 띄우기");
        remote.setOnClickListener(v -> startRemote());
        toolbar.addView(remote, new LinearLayout.LayoutParams(0, -2, 1));
        Button refresh = new Button(this); refresh.setText("새로고침"); refresh.setOnClickListener(v -> web.reload()); toolbar.addView(refresh);
        root.addView(toolbar);
        web = new WebView(this);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setAllowFileAccess(false);
        web.getSettings().setAllowContentAccess(false);
        web.getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("https".equals(uri.getScheme()) && "honeyserve-elo.onrender.com".equals(uri.getHost())) return false;
                if ("https".equals(uri.getScheme())) startActivity(new Intent(Intent.ACTION_VIEW, uri));
                return true;
            }
            @Override public void onPageFinished(WebView view, String url) { CookieManager.getInstance().flush(); }
        });
        // No JavaScript bridge: page content cannot invoke Android or read cookies.
        root.addView(web, new LinearLayout.LayoutParams(-1, 0, 1));
        setContentView(root);
        web.loadUrl(LiveHttp.ORIGIN + "/live/control.html" + (getIntent().getBooleanExtra("finish", false) ? "?end=1" : ""));
        if (Build.VERSION.SDK_INT >= 33) requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 10);
    }

    private void startRemote() {
        if (!Settings.canDrawOverlays(this)) {
            new AlertDialog.Builder(this).setTitle("다른 앱 위에 표시")
                .setMessage("PRISM 촬영 화면 위에 점수 버튼을 표시하려면 허니서브의 표시 권한을 켜 주세요. 권한을 켠 뒤 이 버튼을 다시 누르세요.")
                .setPositiveButton("설정 열기", (d, which) -> startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getPackageName()))))
                .setNegativeButton("취소", null).show();
            return;
        }
        remote.setEnabled(false);
        var executor = Executors.newSingleThreadExecutor();
        executor.execute(() -> {
            try {
                var session = LiveHttp.request("/api/live/current", null).optJSONObject("session");
                if (session == null || !("live".equals(session.optString("status")) || "ready".equals(session.optString("status")))) {
                    throw new Exception("먼저 선수를 선택하고 중계 준비를 눌러 주세요.");
                }
                runOnUiThread(() -> {
                    remote.setEnabled(true);
                    if (isFinishing() || isDestroyed() || !hasWindowFocus()) return;
                    Intent intent = new Intent(this, ScoreOverlayService.class);
                    intent.putExtra("session", session.toString());
                    startForegroundService(intent);
                    moveTaskToBack(true);
                });
            } catch (Exception error) {
                runOnUiThread(() -> { remote.setEnabled(true); Toast.makeText(this, error.getMessage(), Toast.LENGTH_LONG).show(); });
            } finally { executor.shutdown(); }
        });
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        web.loadUrl(LiveHttp.ORIGIN + "/live/control.html" + (intent.getBooleanExtra("finish", false) ? "?end=1" : ""));
    }

    @Override public void onBackPressed() {
        if (web.canGoBack()) web.goBack(); else super.onBackPressed();
    }
    @Override protected void onDestroy() { web.destroy(); super.onDestroy(); }
}
