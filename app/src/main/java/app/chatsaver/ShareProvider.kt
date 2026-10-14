package app.chatsaver

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import java.io.File
import java.io.FileNotFoundException

/**
 * Минимальный провайдер: отдаёт файлы из cache/share для окна «Поделиться».
 * Заменяет androidx FileProvider, чтобы не подключать библиотеки.
 */
class ShareProvider : ContentProvider() {

    companion object {
        fun dir(ctx: Context): File = File(ctx.cacheDir, "share").apply { mkdirs() }
        fun uriFor(ctx: Context, name: String): Uri =
            Uri.Builder().scheme("content").authority(ctx.packageName + ".share").appendPath(name).build()
    }

    private fun fileFor(uri: Uri): File {
        val base = dir(context!!).canonicalFile
        val f = File(base, uri.lastPathSegment ?: throw FileNotFoundException()).canonicalFile
        if (f.parentFile != base || !f.isFile) throw FileNotFoundException()
        return f
    }

    override fun onCreate() = true

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, args: Array<out String>?, sort: String?): Cursor {
        val f = fileFor(uri)
        val cols = projection ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        val c = MatrixCursor(cols)
        c.addRow(cols.map {
            when (it) {
                OpenableColumns.DISPLAY_NAME -> f.name
                OpenableColumns.SIZE -> f.length()
                else -> null
            }
        })
        return c
    }

    override fun getType(uri: Uri) = "text/plain"

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor =
        ParcelFileDescriptor.open(fileFor(uri), ParcelFileDescriptor.MODE_READ_ONLY)

    override fun insert(uri: Uri, values: ContentValues?): Uri? = throw UnsupportedOperationException()
    override fun delete(uri: Uri, selection: String?, args: Array<out String>?): Int = throw UnsupportedOperationException()
    override fun update(uri: Uri, values: ContentValues?, selection: String?, args: Array<out String>?): Int = throw UnsupportedOperationException()
}
