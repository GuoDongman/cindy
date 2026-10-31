package app.cindy.usagewidgets

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.os.Bundle
import android.widget.RemoteViews

/**
 * Home-screen widgets. Each is one bitmap drawn at the launcher cell's size ([WidgetRenderer]),
 * redrawn when the app hands over new data, when the widget is resized, and every 30 minutes so
 * reset countdowns and the "updated" age stay current.
 */
abstract class UsageWidgetProviderBase(private val kind: WidgetKind) : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, appWidgetIds: IntArray) {
    for (id in appWidgetIds) update(context, manager, id, kind)
  }

  override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, appWidgetId: Int, newOptions: Bundle) {
    update(context, manager, appWidgetId, kind)
  }

  /**
   * Debug builds only: `adb shell am broadcast -a app.cindy.usagewidgets.RENDER_PREVIEWS -n <provider>` writes the
   * widgets, drawn from sample data at every layout in both themes, to `cache/widget-previews`.
   */
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action == ACTION_RENDER_PREVIEWS && context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0) {
      renderPreviews(context, intent.getStringExtra("variant") ?: "multi")
      return
    }
    super.onReceive(context, intent)
  }

  override fun onDeleted(context: Context, appWidgetIds: IntArray) {
    for (id in appWidgetIds) WidgetStore.forget(context, id)
  }

  companion object {
    const val ACTION_RENDER_PREVIEWS = "app.cindy.usagewidgets.RENDER_PREVIEWS"

    private fun renderPreviews(context: Context, variant: String) {
      val directory = java.io.File(context.cacheDir, "widget-previews").apply { mkdirs() }
      val sizes = mapOf(
        WidgetFamily.Small to Pair(158f, 158f), WidgetFamily.Medium to Pair(338f, 158f), WidgetFamily.Large to Pair(338f, 354f),
      )
      val states = if (variant == "empty") mapOf("empty" to WidgetState.Empty) else mapOf(variant to WidgetSamples.state(variant))
      for ((name, state) in states) for ((family, size) in sizes) for (dark in listOf(false, true)) for (kind in WidgetKind.values()) {
        val bitmap = WidgetRenderer.render(context, kind, state, size.first, size.second, 3f, dark, family = family)
        java.io.File(directory, "${kind.name.lowercase()}-$name-${family.name.lowercase()}-${if (dark) "dark" else "light"}.png").outputStream().use {
          bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
        }
      }
    }

    /** Redraws every widget of both kinds, for example after the app wrote new data. */
    fun updateAll(context: Context) {
      val manager = AppWidgetManager.getInstance(context)
      for ((provider, kind) in listOf(QuotaWidgetProvider::class.java to WidgetKind.Quota, UsageWidgetProvider::class.java to WidgetKind.Usage)) {
        for (id in manager.getAppWidgetIds(ComponentName(context, provider))) update(context, manager, id, kind)
      }
    }

    fun update(context: Context, manager: AppWidgetManager, appWidgetId: Int, kind: WidgetKind) {
      val density = context.resources.displayMetrics.density
      val options = manager.getAppWidgetOptions(appWidgetId)
      val landscape = context.resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
      val width = (if (landscape) options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH) else options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH))
        .takeIf { it > 0 }?.toFloat() ?: 160f
      val height = (if (landscape) options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT) else options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT))
        .takeIf { it > 0 }?.toFloat() ?: 160f
      val computer = WidgetStore.computerOf(context, appWidgetId)
      if (computer != WidgetStore.AUTO) WidgetStore.recordPin(context, computer)
      val state = WidgetStore.loadState(context, computer)
      // A remote bitmap above the launcher's memory budget is rejected (two are sent, one per theme).
      var drawDensity = density
      val metrics = context.resources.displayMetrics
      val budget = metrics.widthPixels.toLong() * metrics.heightPixels * 4 * 3 / 2
      while (width * drawDensity * height * drawDensity * 4 > budget / 2 && drawDensity > 1f) drawDensity -= 0.25f
      val now = System.currentTimeMillis()
      val views = RemoteViews(context.packageName, R.layout.cindy_usage_widget)
      val description = describe(context, kind, state)
      for ((dark, id) in listOf(false to R.id.cindy_usage_widget_image, true to R.id.cindy_usage_widget_image_dark)) {
        views.setImageViewBitmap(id, WidgetRenderer.render(context, kind, state, width, height, drawDensity, dark, now))
        views.setContentDescription(id, description)
      }
      openAppIntent(context)?.let { views.setOnClickPendingIntent(R.id.cindy_usage_widget_root, it) }
      manager.updateAppWidget(appWidgetId, views)
    }

    private fun describe(context: Context, kind: WidgetKind, state: WidgetState): String {
      val format = WidgetFormat(context, state.snapshotOrNull, System.currentTimeMillis())
      val title = format.text(if (kind == WidgetKind.Quota) "quotaName" else "usageName")
      val snapshot = state.snapshotOrNull ?: return title
      return when (kind) {
        WidgetKind.Quota -> title + ": " + snapshot.sources.joinToString(", ") { source ->
          listOfNotNull(source.name, source.value?.let { it + (source.unit ?: "") }).joinToString(" ")
        }
        WidgetKind.Usage -> {
          val today = snapshot.usage.daily.lastOrNull()
          if (today == null) title else "$title: ${format.tokens(today.totalTokens)} ${format.s("tokenUnit")}"
        }
      }
    }

    private fun openAppIntent(context: Context): PendingIntent? {
      val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
      launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
      return PendingIntent.getActivity(context, 0, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
  }
}

class QuotaWidgetProvider : UsageWidgetProviderBase(WidgetKind.Quota)

class UsageWidgetProvider : UsageWidgetProviderBase(WidgetKind.Usage)
