import ExpoModulesCore

/// iOS placeholder. SenseVoice on iOS needs the sherpa-onnx xcframework, which has
/// not been integrated or built yet (no Xcode on the build machine). Reporting
/// `available = false` makes the app keep using Whisper on iOS.
public class SenseVoiceModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SenseVoice")

    Constants([
      "available": false
    ])

    AsyncFunction("load") { (_: String, _: String, _: Int, _: String) -> [String: Any] in
      throw Exception(name: "ERR_SENSEVOICE_UNAVAILABLE", description: "SenseVoice is not available on iOS yet")
    }

    Function("prepare") { (_: [Int16]) -> Int in
      return 0
    }

    Function("discard") { (_: Int) in }

    AsyncFunction("transcribe") { (_: Int, _: Int, _: String) -> [String: Any] in
      throw Exception(name: "ERR_SENSEVOICE_UNAVAILABLE", description: "SenseVoice is not available on iOS yet")
    }

    AsyncFunction("release") {}
  }
}
