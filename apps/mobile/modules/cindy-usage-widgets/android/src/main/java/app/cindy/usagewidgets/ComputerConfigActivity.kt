package app.cindy.usagewidgets

import android.app.Activity
import android.app.AlertDialog
import android.appwidget.AppWidgetManager
import android.content.Intent
import android.os.Bundle
import java.util.Locale

/**
 * "Data source" of a widget: the computer it shows, or "automatic" (the one that answered the
 * app last). Shown when a widget is added and from the launcher's reconfigure action.
 */
class ComputerConfigActivity : Activity() {
  private var appWidgetId = AppWidgetManager.INVALID_APPWIDGET_ID

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    appWidgetId = intent?.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
      ?: AppWidgetManager.INVALID_APPWIDGET_ID
    setResult(RESULT_CANCELED, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId))
    if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) return finish()

    val computers = WidgetStore.load(this)?.computers ?: emptyList()
    if (computers.isEmpty()) {
      // Nothing to choose from yet: stay on "automatic" and let the widget say what is missing.
      return done(WidgetStore.AUTO)
    }
    val locale = Locale.getDefault()
    val ids = listOf(WidgetStore.AUTO) + computers.map { it.id }
    val names = listOf(WidgetText.text(this, "sourceAuto", locale)) + computers.map { it.name }
    val current = ids.indexOf(WidgetStore.computerOf(this, appWidgetId)).coerceAtLeast(0)
    val night = (resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES
    AlertDialog.Builder(this, if (night) android.R.style.Theme_DeviceDefault_Dialog_Alert else android.R.style.Theme_DeviceDefault_Light_Dialog_Alert)
      .setTitle(WidgetText.text(this, "sourceTitle", locale))
      .setSingleChoiceItems(names.toTypedArray(), current) { dialog, which ->
        dialog.dismiss()
        done(ids[which])
      }
      .setOnCancelListener { finish() }
      .show()
  }

  private fun done(computer: String) {
    WidgetStore.setComputer(this, appWidgetId, computer)
    UsageWidgetProviderBase.update(
      this, AppWidgetManager.getInstance(this), appWidgetId, kindOf(AppWidgetManager.getInstance(this), appWidgetId),
    )
    setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId))
    finish()
  }

  private fun kindOf(manager: AppWidgetManager, id: Int): WidgetKind =
    if (manager.getAppWidgetInfo(id)?.provider?.className == UsageWidgetProvider::class.java.name) WidgetKind.Usage else WidgetKind.Quota
}
