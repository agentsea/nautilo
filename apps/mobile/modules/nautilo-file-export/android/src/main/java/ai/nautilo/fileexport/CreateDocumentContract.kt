package ai.nautilo.fileexport

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import expo.modules.kotlin.activityresult.AppContextActivityResultContract
import java.io.Serializable

/**
 * The operation ID travels through Expo's input-aware result contract. A
 * delayed result can therefore only settle the export that launched it.
 */
internal data class CreateDocumentInput(
  val operationId: String,
  val filename: String,
  val mimeType: String,
) : Serializable

internal data class CreateDocumentResult(
  val operationId: String,
  val destination: Uri?,
)

internal class CreateDocumentContract : AppContextActivityResultContract<CreateDocumentInput, CreateDocumentResult> {
  override fun createIntent(context: Context, input: CreateDocumentInput): Intent =
    Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = input.mimeType
      putExtra(Intent.EXTRA_TITLE, input.filename)
    }

  override fun parseResult(input: CreateDocumentInput, resultCode: Int, intent: Intent?): CreateDocumentResult =
    CreateDocumentResult(
      operationId = input.operationId,
      destination = if (resultCode == Activity.RESULT_OK) intent?.data else null,
    )
}
