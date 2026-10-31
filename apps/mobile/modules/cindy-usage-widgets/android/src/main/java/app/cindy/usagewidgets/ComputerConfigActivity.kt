package app.cindy.usagewidgets

import android.app.Activity
import android.app.AlertDialog
import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.BitmapDrawable
import android.os.Bundle
import android.util.TypedValue
import android.view.ContextThemeWrapper
import android.view.Gravity
import android.view.View
import android.widget.CheckBox
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.ScrollView
import android.widget.TextView
import java.util.Locale

/**
 * A widget's settings, shown when it is added and from the launcher's reconfigure action. Every
 * widget picks its computer, or "automatic" (the one that answered the app last). The quota widget
 * also places accounts first and hides accounts, like the iOS edit sheet and the Mac menu bar's
 * settings; every other account, including ones added later, follows in the computer's order.
 */
class ComputerConfigActivity : Activity() {
  private var appWidgetId = AppWidgetManager.INVALID_APPWIDGET_ID
  private val locale: Locale get() = Locale.getDefault()

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    appWidgetId = intent?.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
      ?: AppWidgetManager.INVALID_APPWIDGET_ID
    setResult(RESULT_CANCELED, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId))
    if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) return finish()

    val store = WidgetStore.load(this)
    val computers = store?.computers ?: emptyList()
    if (computers.isEmpty()) {
      // Nothing to choose from yet: stay on "automatic" and let the widget say what is missing.
      return done(WidgetStore.AUTO)
    }
    if (kindOf(AppWidgetManager.getInstance(this), appWidgetId) == WidgetKind.Quota) {
      QuotaSettings(this, computers).show()
      return
    }
    val ids = listOf(WidgetStore.AUTO) + computers.map { it.id }
    val names = listOf(text("sourceAuto")) + computers.map { it.name }
    val current = ids.indexOf(WidgetStore.computerOf(this, appWidgetId)).coerceAtLeast(0)
    AlertDialog.Builder(this, dialogTheme())
      .setTitle(text("sourceTitle"))
      .setSingleChoiceItems(names.toTypedArray(), current) { dialog, which ->
        dialog.dismiss()
        done(ids[which])
      }
      .setOnCancelListener { finish() }
      .show()
  }

  private fun done(computer: String, pinned: List<String>? = null, hidden: List<String>? = null) {
    WidgetStore.setComputer(this, appWidgetId, computer)
    if (pinned != null && hidden != null) WidgetStore.setAccounts(this, appWidgetId, pinned, hidden)
    UsageWidgetProviderBase.update(
      this, AppWidgetManager.getInstance(this), appWidgetId, kindOf(AppWidgetManager.getInstance(this), appWidgetId),
    )
    setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId))
    finish()
  }

  private fun text(key: String) = WidgetText.text(this, key, locale)

  private val night: Boolean
    get() = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

  private fun dialogTheme() =
    if (night) android.R.style.Theme_DeviceDefault_Dialog_Alert else android.R.style.Theme_DeviceDefault_Light_Dialog_Alert

  private fun kindOf(manager: AppWidgetManager, id: Int): WidgetKind =
    if (manager.getAppWidgetInfo(id)?.provider?.className == UsageWidgetProvider::class.java.name) WidgetKind.Usage else WidgetKind.Quota

  /**
   * The quota widget's settings: the computer, the accounts placed first (in order, up to what the
   * large size shows) and the hidden accounts. The lists offer the chosen computer's accounts;
   * choices that name another computer's account stay and find it again by logo and name.
   */
  private inner class QuotaSettings(context: Context, private val computers: List<WidgetStore.Computer>) {
    private val ui = ContextThemeWrapper(context, dialogTheme())
    // A computer that is gone (removed, remote control off, another account) shows as "automatic", so that is
    // also what Done saves; otherwise the widget would keep the missing id and stay empty.
    private var computer = WidgetStore.computerOf(context, appWidgetId)
      .takeIf { id -> id == WidgetStore.AUTO || computers.any { it.id == id } } ?: WidgetStore.AUTO
    private val pinned = WidgetStore.pinnedOf(context, appWidgetId).toMutableList()
    private val hidden = WidgetStore.hiddenOf(context, appWidgetId).toMutableList()
    private val accountsBox = LinearLayout(ui).apply { orientation = LinearLayout.VERTICAL }

    fun show() {
      val content = LinearLayout(ui).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(24), dp(8), dp(24), dp(8))
        addView(header(text("configComputer")))
        addView(computerChoice())
        addView(accountsBox)
      }
      renderAccounts()
      AlertDialog.Builder(ui)
        .setTitle(text("quotaName"))
        .setView(ScrollView(ui).apply { addView(content) })
        .setPositiveButton(text("configDone")) { _, _ -> done(computer, pinned.toList(), hidden.toList()) }
        .setNegativeButton(text("configCancel")) { _, _ -> finish() }
        .setOnCancelListener { finish() }
        .show()
    }

    private fun computerChoice(): View {
      val ids = listOf(WidgetStore.AUTO) + computers.map { it.id }
      val names = listOf(text("sourceAuto")) + computers.map { it.name }
      return RadioGroup(ui).apply {
        ids.forEachIndexed { index, id ->
          addView(RadioButton(ui).apply {
            this.id = View.generateViewId()
            text = names[index]
            isChecked = id == computer
            setOnCheckedChangeListener { _, checked ->
              if (checked && computer != id) {
                computer = id
                renderAccounts()
              }
            }
          })
        }
      }
    }

    /** The chosen computer's accounts, in its order (hidden ones on the computer are not sent). */
    private fun sources(): List<WidgetSource> =
      WidgetStore.loadState(ui, computer).snapshotOrNull?.sources ?: emptyList()

    private fun renderAccounts() {
      accountsBox.removeAllViews()
      val sources = sources()
      accountsBox.addView(header(text("configPinned")))
      pinned.forEachIndexed { index, encoded ->
        val key = AccountKey.decode(encoded)
        accountsBox.addView(row(key.logo, key.name) {
          addView(iconButton(android.R.drawable.arrow_up_float, text("configMoveUp"), index > 0) { move(index, -1) })
          addView(iconButton(android.R.drawable.arrow_down_float, text("configMoveDown"), index < pinned.size - 1) { move(index, 1) })
          addView(iconButton(android.R.drawable.ic_menu_close_clear_cancel, text("configRemove"), true) {
            pinned.removeAt(index)
            renderAccounts()
          })
        })
      }
      val addable = sources.filter { AccountKey.matching(pinned, listOf(it)).isEmpty() }
      if (pinned.size < MAX_PINNED && addable.isNotEmpty()) {
        accountsBox.addView(TextView(ui).apply {
          text = "+  " + text("configAdd")
          setTextColor(resolveColor(android.R.attr.colorAccent))
          textSize = 15f
          setPadding(0, dp(10), 0, dp(10))
          setOnClickListener { pickPinned(addable) }
        })
      }
      accountsBox.addView(hint(text("configPinnedHint")))

      accountsBox.addView(header(text("configHidden")))
      if (sources.isEmpty()) accountsBox.addView(hint(text("noSources")))
      for (source in sources) {
        accountsBox.addView(CheckBox(ui).apply {
          text = source.name
          setCompoundDrawablesRelativeWithIntrinsicBounds(logo(source.logo, source.monogram), null, null, null)
          compoundDrawablePadding = dp(8)
          isChecked = AccountKey.matching(hidden, listOf(source)).isNotEmpty()
          setOnCheckedChangeListener { _, checked ->
            // Unchecking also drops the same account saved from another computer.
            hidden.removeAll { AccountKey.matching(listOf(it), listOf(source)).isNotEmpty() }
            if (checked) hidden.add(AccountKey(source).encoded)
          }
        })
      }
    }

    private fun move(index: Int, by: Int) {
      val target = index + by
      if (target !in pinned.indices) return
      pinned.add(target, pinned.removeAt(index))
      renderAccounts()
    }

    private fun pickPinned(addable: List<WidgetSource>) {
      AlertDialog.Builder(ui)
        .setTitle(text("configPinned"))
        .setItems(addable.map { it.name }.toTypedArray()) { _, which ->
          pinned.add(AccountKey(addable[which]).encoded)
          renderAccounts()
        }
        .show()
    }

    private fun row(logo: String?, name: String, actions: LinearLayout.() -> Unit) = LinearLayout(ui).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      minimumHeight = dp(44)
      addView(TextView(ui).apply {
        text = name
        textSize = 15f
        setTextColor(resolveColor(android.R.attr.textColorPrimary))
        setCompoundDrawablesRelativeWithIntrinsicBounds(logo(logo, name.take(1).uppercase()), null, null, null)
        compoundDrawablePadding = dp(10)
      }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
      actions()
    }

    private fun iconButton(icon: Int, label: String, enabled: Boolean, onClick: () -> Unit) = ImageButton(ui).apply {
      setImageResource(icon)
      contentDescription = label
      isEnabled = enabled
      alpha = if (enabled) 1f else 0.3f
      background = null
      setColorFilter(resolveColor(android.R.attr.textColorSecondary))
      setOnClickListener { onClick() }
      layoutParams = LinearLayout.LayoutParams(dp(40), dp(40))
    }

    private fun header(label: String) = TextView(ui).apply {
      text = label
      textSize = 13f
      setTextColor(resolveColor(android.R.attr.textColorSecondary))
      setPadding(0, dp(16), 0, dp(4))
    }

    private fun hint(label: String) = TextView(ui).apply {
      text = label
      textSize = 12f
      setTextColor(resolveColor(android.R.attr.textColorSecondary))
      setPadding(0, 0, 0, dp(4))
    }

    /** The account's mark, drawn like on the widget, in the dialog's secondary text color. */
    private fun logo(logo: String?, monogram: String): BitmapDrawable {
      val density = ui.resources.displayMetrics.density
      val size = 20f
      val bitmap = Bitmap.createBitmap((size * density).toInt(), (size * density).toInt(), Bitmap.Config.ARGB_8888)
      val canvas = Canvas(bitmap).apply { scale(density, density) }
      WidgetPainter(ui, canvas, WidgetPalette(night)).logo(logo, monogram, 0f, 0f, size, resolveColor(android.R.attr.textColorSecondary))
      return BitmapDrawable(ui.resources, bitmap)
    }

    private fun resolveColor(attr: Int): Int {
      val value = TypedValue()
      ui.theme.resolveAttribute(attr, value, true)
      return if (value.resourceId != 0) ui.getColor(value.resourceId) else value.data
    }

    private fun dp(value: Int) = (value * ui.resources.displayMetrics.density).toInt()
  }

  companion object {
    /** As many as the large layout shows. */
    private const val MAX_PINNED = 7
  }
}
