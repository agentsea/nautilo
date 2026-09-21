package ai.nautilo.voicepcm

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Handler
import android.os.Build
import android.os.HandlerThread
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.ArrayDeque

class NautiloVoicePcmModule : Module() {
  private val thread = HandlerThread("NautiloSpeech").apply { start() }
  private val handler = Handler(thread.looper)
  private var track: AudioTrack? = null
  private var streamId: String? = null
  private var submitted = 0L
  private var consumed = 0L
  private var finished = false
  private var offset = 0
  private val queue = ArrayDeque<ByteArray>()
  private var focus: AudioFocusRequest? = null
  private var legacyFocus = false
  private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
    if (change < 0) handler.post { terminate("audio_interrupted") }
  }
  private var receiver: BroadcastReceiver? = null
  private val attributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
  // Transport credit window: four seconds of mono PCM16 at 24 kHz.
  private val capacitySamples = 24_000 * 4
  private val startupSamples = 24_000 * 80 / 1000
  private val audioManager get() = appContext.reactContext?.getSystemService(Context.AUDIO_SERVICE) as? AudioManager

  override fun definition() = ModuleDefinition {
    Name("NautiloVoicePcm")
    Events("status")
    OnCreate {
      receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
          handler.post { terminate("audio_interrupted") }
        }
      }
      appContext.reactContext?.registerReceiver(receiver, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY))
    }
    AsyncFunction("begin") { id: String, promise: Promise -> dispatch(promise) {
      terminate()
      val manager = audioManager ?: error("Audio session unavailable")
      val granted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
          .setAudioAttributes(attributes).setOnAudioFocusChangeListener(focusListener, handler).build()
        focus = request
        manager.requestAudioFocus(request)
      } else {
        legacyFocus = true
        @Suppress("DEPRECATION")
        manager.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
      }
      check(granted == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) { "Audio focus unavailable" }
      val minimum = AudioTrack.getMinBufferSize(24_000, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
      check(minimum > 0) { "PCM format unavailable" }
      val sink = AudioTrack.Builder().setAudioAttributes(attributes)
        .setAudioFormat(AudioFormat.Builder().setSampleRate(24_000).setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
          .setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
        .setTransferMode(AudioTrack.MODE_STREAM).setBufferSizeInBytes(maxOf(minimum, startupSamples * 2)).build()
      track = sink
      check(sink.state == AudioTrack.STATE_INITIALIZED) { "Audio output unavailable" }
      streamId = id; submitted = 0; consumed = 0; finished = false
      handler.post(pump)
    } }
    AsyncFunction("write") { id: String, bytes: ByteArray, promise: Promise -> dispatch(promise) {
      if (streamId == id && !finished) {
        check(bytes.isNotEmpty() && bytes.size % 2 == 0 && bytes.size <= 48_000 &&
          submitted - consumed + bytes.size / 2 <= capacitySamples) { "Invalid PCM queue" }
        queue.add(bytes.copyOf()); submitted += bytes.size / 2
      }
    } }
    AsyncFunction("finish") { id: String, promise: Promise -> dispatch(promise) {
      if (streamId == id) finished = true
    } }
    AsyncFunction("stop") { id: String, promise: Promise -> dispatch(promise) {
      if (streamId == id) terminate()
    } }
    // AppState detaches the listener; a normal background stop must not disable Voice On.
    OnActivityEntersBackground { handler.post { terminate() } }
    OnDestroy {
      receiver?.let { appContext.reactContext?.unregisterReceiver(it) }
      handler.post { terminate(); thread.quitSafely() }
    }
  }

  private fun dispatch(promise: Promise, action: () -> Unit) {
    handler.post {
      try { action(); promise.resolve(null) }
      catch (_: Exception) { terminate("audio_unavailable"); promise.reject("ERR_SPEECH_OUTPUT", "Speech output unavailable", null) }
    }
  }
  private val pump = object : Runnable {
    override fun run() {
      val sink = track ?: return
      try {
        while (queue.isNotEmpty()) {
          val bytes = queue.first()
          val written = sink.write(bytes, offset, bytes.size - offset, AudioTrack.WRITE_NON_BLOCKING)
          check(written >= 0) { "PCM write failed" }
          if (written == 0) break
          offset += written
          if (offset == bytes.size) { queue.removeFirst(); offset = 0 }
        }
        if (sink.playState != AudioTrack.PLAYSTATE_PLAYING && (submitted >= startupSamples || finished)) sink.play()
        // AudioTrack exposes an unsigned 32-bit frame clock, including wrap.
        val head = sink.playbackHeadPosition.toLong() and 0xffffffffL
        var absolute = (consumed and -0x100000000L) or head
        if (absolute < consumed) absolute += 0x100000000L
        val next = minOf(submitted, absolute)
        if (next != consumed || finished && next == submitted) { consumed = next; publish() }
        if (finished && consumed == submitted) { terminate(); return }
        handler.postDelayed(this, 20)
      } catch (_: Exception) { terminate("audio_unavailable") }
    }
  }
  private fun publish(error: String? = null) {
    val id = streamId ?: return
    val status = mutableMapOf<String, Any>("streamId" to id, "consumedSamples" to consumed.toDouble(),
      "playing" to (error == null && track?.playState == AudioTrack.PLAYSTATE_PLAYING && consumed < submitted),
      "ended" to (finished && consumed == submitted))
    if (error != null) status["error"] = error
    sendEvent("status", status)
  }
  private fun terminate(error: String? = null) {
    if (error != null) publish(error)
    streamId = null
    handler.removeCallbacks(pump)
    track?.let {
      try { it.pause(); it.flush() } catch (_: Exception) {}
      finally { it.release() }
    }
    track = null; queue.clear(); offset = 0
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) focus?.let { audioManager?.abandonAudioFocusRequest(it) }
    focus = null
    if (legacyFocus) {
      @Suppress("DEPRECATION")
      audioManager?.abandonAudioFocus(focusListener)
      legacyFocus = false
    }
  }
}
