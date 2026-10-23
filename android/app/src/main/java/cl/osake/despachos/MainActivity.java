package cl.osake.despachos;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.SslErrorHandler;
import android.webkit.URLUtil;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.EdgeToEdge;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.SystemBarStyle;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.appcompat.widget.Toolbar;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.google.android.gms.common.ConnectionResult;
import com.google.android.gms.common.GoogleApiAvailability;
import com.google.mlkit.common.MlKitException;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanner;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;

import org.json.JSONObject;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;
import java.util.Map;

/**
 * Cliente del piloto de despachos: un WebView que carga el servidor configurado
 * y agrega escaneo QR (Google Code Scanner) y geolocalización puntual.
 */
public class MainActivity extends AppCompatActivity {

    private static final String PREFS = "config";
    private static final String KEY_SERVER_URL = "server_url";
    private static final String STATE_WEBVIEW = "webview_state";

    private WebView webView;
    private View errorPanel;
    private TextView errorTitle;
    private TextView errorMessage;
    private ProgressBar progress;
    private OnBackPressedCallback backCallback;

    /** URL configurada (normalizada) o null si aún no hay servidor. */
    @Nullable
    private String serverUrl;
    /** Origen configurado (esquema, host y puerto efectivo) o null. */
    @Nullable
    private Origin serverOrigin;

    /** URL del frame principal que falló, para "Reintentar". */
    @Nullable
    private String failedUrl;
    private boolean mainFrameError;
    private boolean clearHistoryOnNextPage;

    @Nullable
    private String pendingGeoOrigin;
    @Nullable
    private GeolocationPermissions.Callback pendingGeoCallback;

    private final ActivityResultLauncher<String[]> locationPermissionLauncher =
            registerForActivityResult(new ActivityResultContracts.RequestMultiplePermissions(),
                    this::onLocationPermissionResult);

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        EdgeToEdge.enable(this,
                SystemBarStyle.dark(Color.TRANSPARENT),
                SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT));
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        Toolbar toolbar = findViewById(R.id.toolbar);
        setSupportActionBar(toolbar);
        View root = findViewById(R.id.root);
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars()
                    | WindowInsetsCompat.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            v.setPadding(bars.left, 0, bars.right, Math.max(bars.bottom, ime.bottom));
            toolbar.setPadding(toolbar.getPaddingLeft(), bars.top,
                    toolbar.getPaddingRight(), toolbar.getPaddingBottom());
            return WindowInsetsCompat.CONSUMED;
        });

        webView = findViewById(R.id.webview);
        errorPanel = findViewById(R.id.error_panel);
        errorTitle = findViewById(R.id.error_title);
        errorMessage = findViewById(R.id.error_message);
        progress = findViewById(R.id.progress);
        Button retry = findViewById(R.id.btn_retry);
        Button settingsButton = findViewById(R.id.btn_settings);
        retry.setOnClickListener(v -> retry());
        settingsButton.setOnClickListener(v -> showServerDialog());

        configureWebView();

        backCallback = new OnBackPressedCallback(false) {
            @Override
            public void handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack();
                } else {
                    // Sin historial: dejar que el sistema cierre la actividad.
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                }
            }
        };
        getOnBackPressedDispatcher().addCallback(this, backCallback);

        String stored = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_SERVER_URL, null);
        String normalized = stored == null ? null : normalizeServerUrl(stored);
        if (normalized == null) {
            showNoServer();
            showServerDialog();
            return;
        }
        setServer(normalized);

        boolean restored = false;
        if (savedInstanceState != null) {
            Bundle webState = savedInstanceState.getBundle(STATE_WEBVIEW);
            if (webState != null && webView.restoreState(webState) != null) {
                restored = true;
            }
        }
        if (!restored) {
            webView.loadUrl(serverUrl);
        }
        backCallback.setEnabled(webView.canGoBack());
    }

    @SuppressLint("SetJavaScriptEnabled") // La app es un contenedor de la web del piloto; requiere JS.
    private void configureWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setGeolocationEnabled(true);
        s.setSupportMultipleWindows(true);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            s.setSafeBrowsingEnabled(true);
        }

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, false);

        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        webView.addJavascriptInterface(new Bridge(), "AndroidApp");
        webView.setWebViewClient(new AppWebViewClient());
        webView.setWebChromeClient(new AppChromeClient());
        webView.setDownloadListener(this::onDownloadRequested);
    }

    // ------------------------------------------------------------- descargas

    /**
     * Descargas (p. ej. el CSV de /api/export.csv con atributo download). Solo se aceptan del
     * origen configurado; se usa DownloadManager pasando la cookie de sesión del WebView.
     */
    private void onDownloadRequested(String url, String userAgent, String contentDisposition,
                                     String mimeType, long contentLength) {
        if (!isConfiguredOrigin(url)) {
            Uri uri = Uri.parse(url);
            if (uri.getScheme() != null) {
                openExternally(uri);
            }
            return;
        }
        String fileName = URLUtil.guessFileName(url, contentDisposition, mimeType);
        DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
        String cookie = CookieManager.getInstance().getCookie(url);
        if (cookie != null) {
            request.addRequestHeader("Cookie", cookie);
        }
        if (userAgent != null) {
            request.addRequestHeader("User-Agent", userAgent);
        }
        if (mimeType != null && !mimeType.isEmpty()) {
            request.setMimeType(mimeType);
        }
        request.setTitle(fileName);
        request.setNotificationVisibility(
                DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // Android 10+: carpeta pública Descargas sin permisos extra.
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
        } else {
            // Android 6 a 9: carpeta propia de la app (no requiere WRITE_EXTERNAL_STORAGE);
            // se abre desde la notificación de descarga.
            request.setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, fileName);
        }
        DownloadManager dm = ContextCompat.getSystemService(this, DownloadManager.class);
        if (dm == null) {
            Toast.makeText(this, R.string.download_failed, Toast.LENGTH_LONG).show();
            return;
        }
        try {
            dm.enqueue(request);
            Toast.makeText(this, getString(R.string.download_started, fileName), Toast.LENGTH_SHORT).show();
        } catch (IllegalArgumentException | SecurityException e) {
            Toast.makeText(this, R.string.download_failed, Toast.LENGTH_LONG).show();
        }
    }

    // ---------------------------------------------------------------- servidor

    private void setServer(@NonNull String url) {
        serverUrl = url;
        serverOrigin = Origin.of(Uri.parse(url));
    }

    private void showServerDialog() {
        View content = getLayoutInflater().inflate(R.layout.dialog_server, null);
        TextView message = content.findViewById(R.id.server_message);
        EditText input = content.findViewById(R.id.server_url);
        TextView error = content.findViewById(R.id.server_error);
        message.setText(BuildConfig.DEBUG ? R.string.settings_message_debug : R.string.settings_message);
        input.setText(serverUrl != null ? serverUrl : "https://");
        input.setSelection(input.getText().length());

        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle(R.string.settings_title)
                .setView(content)
                .setPositiveButton(R.string.settings_save, null)
                .setNegativeButton(R.string.settings_cancel, null)
                .create();
        dialog.setOnShowListener(d -> {
            Runnable save = () -> {
                String raw = input.getText().toString().trim();
                int problem = validateServerUrl(raw);
                if (problem != 0) {
                    error.setText(problem);
                    error.setVisibility(View.VISIBLE);
                    return;
                }
                String normalized = normalizeServerUrl(raw);
                if (normalized == null) {
                    error.setText(R.string.url_error_invalid);
                    error.setVisibility(View.VISIBLE);
                    return;
                }
                dialog.dismiss();
                applyNewServer(normalized);
            };
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> save.run());
            input.setOnEditorActionListener((v, actionId, event) -> {
                if (actionId == EditorInfo.IME_ACTION_DONE) {
                    save.run();
                    return true;
                }
                return false;
            });
        });
        dialog.show();
    }

    /** Guarda el nuevo servidor, borra cookies y datos web del anterior y recarga. */
    private void applyNewServer(@NonNull String url) {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_SERVER_URL, url).apply();
        setServer(url);
        denyPendingGeolocation();
        webView.stopLoading();
        WebStorage.getInstance().deleteAllData();
        webView.clearCache(false);
        CookieManager.getInstance().removeAllCookies(removed -> {
            CookieManager.getInstance().flush();
            clearHistoryOnNextPage = true;
            hideError();
            webView.loadUrl(url);
        });
    }

    /** 0 si la URL es aceptable; si no, el id del mensaje de error. */
    private static int validateServerUrl(@NonNull String raw) {
        if (raw.isEmpty() || raw.equals("https://")) {
            return R.string.url_error_empty;
        }
        URI uri;
        try {
            uri = new URI(raw);
        } catch (URISyntaxException e) {
            return R.string.url_error_invalid;
        }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        String host = uri.getHost();
        if (host == null || host.isEmpty() || uri.getRawUserInfo() != null) {
            return R.string.url_error_invalid;
        }
        if (scheme.equals("https")) {
            return 0;
        }
        if (BuildConfig.DEBUG && scheme.equals("http") && host.equals("10.0.2.2")) {
            return 0;
        }
        return BuildConfig.DEBUG ? R.string.url_error_https_debug : R.string.url_error_https;
    }

    /** Devuelve esquema://host[:puerto]/ruta[?consulta] o null si no es válida. */
    @Nullable
    private static String normalizeServerUrl(@NonNull String raw) {
        if (validateServerUrl(raw) != 0) {
            return null;
        }
        try {
            URI uri = new URI(raw);
            String scheme = uri.getScheme().toLowerCase(Locale.ROOT);
            String host = uri.getHost().toLowerCase(Locale.ROOT);
            StringBuilder sb = new StringBuilder(scheme).append("://").append(host);
            if (uri.getPort() != -1) {
                sb.append(':').append(uri.getPort());
            }
            String path = uri.getRawPath();
            sb.append(path == null || path.isEmpty() ? "/" : path);
            if (uri.getRawQuery() != null) {
                sb.append('?').append(uri.getRawQuery());
            }
            return sb.toString();
        } catch (URISyntaxException e) {
            return null;
        }
    }

    private boolean isConfiguredOrigin(@Nullable Uri uri) {
        return serverOrigin != null && uri != null && serverOrigin.equals(Origin.of(uri));
    }

    private boolean isConfiguredOrigin(@Nullable String url) {
        return url != null && isConfiguredOrigin(Uri.parse(url));
    }

    /** La página mostrada pertenece al servidor configurado. Llamar en el hilo UI. */
    private boolean isTrustedPage() {
        return !mainFrameError && isConfiguredOrigin(webView.getUrl());
    }

    // ------------------------------------------------------------ navegación

    /** Abre fuera de la app (navegador, teléfono, mapas...). */
    private void openExternally(@NonNull Uri uri) {
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        switch (scheme) {
            case "http":
            case "https":
            case "tel":
            case "geo":
            case "mailto":
            case "sms":
            case "smsto":
                break;
            default:
                // intent:, file:, content:, javascript:, etc. no se abren.
                Toast.makeText(this, R.string.link_blocked, Toast.LENGTH_SHORT).show();
                return;
        }
        Intent intent = new Intent(Intent.ACTION_VIEW, uri);
        intent.addCategory(Intent.CATEGORY_BROWSABLE);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            startActivity(intent);
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, R.string.no_app_for_link, Toast.LENGTH_SHORT).show();
        }
    }

    /** Navegación pedida por la página: mismo origen dentro del WebView, el resto afuera. */
    private void handleNavigation(@NonNull Uri uri) {
        if (isConfiguredOrigin(uri)) {
            webView.loadUrl(uri.toString());
        } else {
            openExternally(uri);
        }
    }

    private void retry() {
        if (serverUrl == null) {
            showServerDialog();
            return;
        }
        hideError();
        String target = failedUrl != null && isConfiguredOrigin(failedUrl) ? failedUrl : serverUrl;
        webView.loadUrl(target);
    }

    private void showNoServer() {
        errorTitle.setText(R.string.no_server_title);
        errorMessage.setText(R.string.no_server_message);
        errorPanel.setVisibility(View.VISIBLE);
    }

    private void showError(@NonNull String message) {
        errorTitle.setText(R.string.error_title);
        errorMessage.setText(message);
        errorPanel.setVisibility(View.VISIBLE);
        progress.setVisibility(View.GONE);
    }

    private void hideError() {
        mainFrameError = false;
        errorPanel.setVisibility(View.GONE);
    }

    private class AppWebViewClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (isConfiguredOrigin(uri)) {
                return false;
            }
            openExternally(uri);
            return true;
        }

        /**
         * Android 6 (API 23) solo llama a esta versión: sin ella, tel:, mapas y redirecciones a otros
         * orígenes se cargarían dentro del WebView.
         */
        @SuppressWarnings("deprecation")
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                return false; // API 24+ usa la versión con WebResourceRequest.
            }
            Uri uri = url == null ? null : Uri.parse(url);
            if (uri == null || isConfiguredOrigin(uri)) {
                return false;
            }
            openExternally(uri);
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            mainFrameError = false;
            failedUrl = null;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (!mainFrameError) {
                errorPanel.setVisibility(View.GONE);
            }
            if (clearHistoryOnNextPage) {
                clearHistoryOnNextPage = false;
                view.clearHistory();
            }
            CookieManager.getInstance().flush();
        }

        @Override
        public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
            backCallback.setEnabled(view.canGoBack());
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (!request.isForMainFrame()) {
                return;
            }
            mainFrameError = true;
            failedUrl = request.getUrl().toString();
            String detail = error.getDescription() == null ? "" : error.getDescription().toString();
            String text = getString(R.string.error_generic);
            if (!detail.isEmpty()) {
                text = text + "\n\n" + getString(R.string.error_detail, detail);
            }
            showError(text);
        }

        /** Nunca se acepta un certificado inválido: se cancela y se avisa si es del servidor. */
        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            handler.cancel();
            String url = error.getUrl();
            if (isConfiguredOrigin(url) || (url != null && url.equals(view.getUrl()))) {
                mainFrameError = true;
                failedUrl = url;
                showError(getString(R.string.error_ssl));
            }
        }
    }

    private class AppChromeClient extends WebChromeClient {
        @Override
        public void onProgressChanged(WebView view, int newProgress) {
            progress.setProgress(newProgress);
            progress.setVisibility(newProgress < 100 ? View.VISIBLE : View.GONE);
        }

        /**
         * window.open / target=_blank (p. ej. la etiqueta QR). Se captura la URL con un WebView
         * temporal: si es del mismo origen se abre en el WebView principal (conserva la sesión;
         * se vuelve con Atrás); si es de otro origen, afuera.
         */
        @Override
        public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
            if (!isUserGesture) {
                return false;
            }
            WebView temp = new WebView(MainActivity.this);
            temp.setWebViewClient(new WebViewClient() {
                private boolean handled;

                private void capture(WebView w, @Nullable Uri uri) {
                    if (handled || uri == null || "about".equalsIgnoreCase(uri.getScheme())) {
                        return;
                    }
                    handled = true;
                    w.stopLoading();
                    handleNavigation(uri);
                    // View.post en un WebView sin adjuntar no se ejecuta en API 24+: se usa el hilo principal.
                    new Handler(Looper.getMainLooper()).post(w::destroy);
                }

                @Override
                public boolean shouldOverrideUrlLoading(WebView w, WebResourceRequest request) {
                    capture(w, request.getUrl());
                    return true;
                }

                @SuppressWarnings("deprecation")
                @Override
                public boolean shouldOverrideUrlLoading(WebView w, String url) {
                    capture(w, url == null ? null : Uri.parse(url));
                    return true;
                }

                @Override
                public void onPageStarted(WebView w, String url, Bitmap favicon) {
                    capture(w, url == null ? null : Uri.parse(url));
                }
            });
            WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
            transport.setWebView(temp);
            resultMsg.sendToTarget();
            return true;
        }

        @Override
        public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
            if (!isConfiguredOrigin(origin)) {
                callback.invoke(origin, false, false);
                return;
            }
            if (hasLocationPermission()) {
                callback.invoke(origin, true, false);
                return;
            }
            denyPendingGeolocation();
            pendingGeoOrigin = origin;
            pendingGeoCallback = callback;
            locationPermissionLauncher.launch(new String[]{
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION});
        }

        @Override
        public void onGeolocationPermissionsHidePrompt() {
            pendingGeoOrigin = null;
            pendingGeoCallback = null;
        }
    }

    // ---------------------------------------------------------- ubicación

    private boolean hasLocationPermission() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED
                || ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
    }

    private void onLocationPermissionResult(Map<String, Boolean> result) {
        String origin = pendingGeoOrigin;
        GeolocationPermissions.Callback callback = pendingGeoCallback;
        pendingGeoOrigin = null;
        pendingGeoCallback = null;
        if (origin == null || callback == null) {
            return;
        }
        boolean granted = Boolean.TRUE.equals(result.get(Manifest.permission.ACCESS_FINE_LOCATION))
                || Boolean.TRUE.equals(result.get(Manifest.permission.ACCESS_COARSE_LOCATION));
        // retain=false: el WebView vuelve a preguntar en cada uso; Android recuerda el permiso.
        callback.invoke(origin, granted && isConfiguredOrigin(origin), false);
    }

    private void denyPendingGeolocation() {
        if (pendingGeoCallback != null && pendingGeoOrigin != null) {
            pendingGeoCallback.invoke(pendingGeoOrigin, false, false);
        }
        pendingGeoOrigin = null;
        pendingGeoCallback = null;
    }

    // ---------------------------------------------------------------- escaneo

    private void startScan() {
        if (!isTrustedPage()) {
            Toast.makeText(this, R.string.scan_not_allowed, Toast.LENGTH_SHORT).show();
            return;
        }
        int gms = GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(this);
        if (gms != ConnectionResult.SUCCESS) {
            Toast.makeText(this, R.string.scan_no_play_services, Toast.LENGTH_LONG).show();
            return;
        }
        GmsBarcodeScannerOptions options = new GmsBarcodeScannerOptions.Builder()
                .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                .build();
        GmsBarcodeScanner scanner = GmsBarcodeScanning.getClient(this, options);
        scanner.startScan()
                .addOnSuccessListener(barcode -> {
                    String text = barcode.getRawValue();
                    if (text != null) {
                        sendScanToWeb(text);
                    }
                })
                .addOnCanceledListener(() -> {
                    // El usuario cerró el lector: no se hace nada.
                })
                .addOnFailureListener(e -> {
                    boolean downloading = e instanceof MlKitException
                            && ((MlKitException) e).getErrorCode() == MlKitException.UNAVAILABLE;
                    Toast.makeText(this,
                            downloading ? R.string.scan_module_downloading : R.string.scan_failed,
                            Toast.LENGTH_LONG).show();
                });
    }

    private void sendScanToWeb(@NonNull String text) {
        if (!isTrustedPage()) {
            return;
        }
        String js = "window.dispatchEvent(new CustomEvent('android-scan',{detail:{text:"
                + JSONObject.quote(text) + "}}))";
        webView.evaluateJavascript(js, null);
    }

    /** Objeto expuesto a la web como window.AndroidApp. Solo scan() y openSettings(). */
    private class Bridge {
        @JavascriptInterface
        public void scan() {
            runOnUiThread(() -> {
                if (isTrustedPage()) {
                    startScan();
                }
            });
        }

        @JavascriptInterface
        public void openSettings() {
            runOnUiThread(() -> {
                if (isTrustedPage()) {
                    showServerDialog();
                }
            });
        }
    }

    // ------------------------------------------------------------------ menú

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        getMenuInflater().inflate(R.menu.main, menu);
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(@NonNull MenuItem item) {
        int id = item.getItemId();
        if (id == R.id.action_scan) {
            startScan();
            return true;
        } else if (id == R.id.action_refresh) {
            if (serverUrl == null) {
                showServerDialog();
            } else if (mainFrameError || webView.getUrl() == null) {
                retry();
            } else {
                webView.reload();
            }
            return true;
        } else if (id == R.id.action_settings) {
            showServerDialog();
            return true;
        }
        return super.onOptionsItemSelected(item);
    }

    // ------------------------------------------------------------ ciclo de vida

    @Override
    protected void onSaveInstanceState(@NonNull Bundle outState) {
        super.onSaveInstanceState(outState);
        Bundle webState = new Bundle();
        webView.saveState(webState);
        outState.putBundle(STATE_WEBVIEW, webState);
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
    }

    @Override
    protected void onPause() {
        webView.onPause();
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        denyPendingGeolocation();
        webView.stopLoading();
        webView.setWebChromeClient(null);
        webView.setWebViewClient(new WebViewClient());
        webView.destroy();
        super.onDestroy();
    }

    /** Origen web: esquema + host + puerto efectivo (443/80 por defecto). */
    private static final class Origin {
        final String scheme;
        final String host;
        final int port;

        private Origin(String scheme, String host, int port) {
            this.scheme = scheme;
            this.host = host;
            this.port = port;
        }

        @Nullable
        static Origin of(@NonNull Uri uri) {
            String scheme = uri.getScheme();
            String host = uri.getHost();
            if (scheme == null || host == null || host.isEmpty()) {
                return null;
            }
            scheme = scheme.toLowerCase(Locale.ROOT);
            int port = uri.getPort();
            if (port == -1) {
                if (scheme.equals("https")) {
                    port = 443;
                } else if (scheme.equals("http")) {
                    port = 80;
                } else {
                    return null;
                }
            }
            return new Origin(scheme, host.toLowerCase(Locale.ROOT), port);
        }

        @Override
        public boolean equals(Object o) {
            if (this == o) return true;
            if (!(o instanceof Origin)) return false;
            Origin other = (Origin) o;
            return port == other.port && scheme.equals(other.scheme) && host.equals(other.host);
        }

        @Override
        public int hashCode() {
            return (scheme.hashCode() * 31 + host.hashCode()) * 31 + port;
        }
    }
}
