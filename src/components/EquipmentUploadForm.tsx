import Ionicons from "@expo/vector-icons/Ionicons";
import * as ImagePicker from "expo-image-picker";
import { useNetworkState } from "expo-network";
import { useState, type ComponentProps } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { colors, spacing } from "@/constants/theme";
import {
  useEquipmentUpload,
  type ImageUploadStatus,
} from "@/hooks/useEquipmentUpload";
import { UploadError, describeUploadError } from "@/lib/api/errors";

/** Must match the server's maxImages. */
const MAX_IMAGES = 50;

const CAMERA_OPTIONS: ImagePicker.ImagePickerOptions = {
  mediaTypes: ["images"],
  quality: 0.8,
};

const LIBRARY_OPTIONS: ImagePicker.ImagePickerOptions = {
  ...CAMERA_OPTIONS,
  allowsMultipleSelection: true,
  selectionLimit: MAX_IMAGES,
  orderedSelection: true,
};

const DANGER = "#DC2626";
const SUCCESS = "#16A34A";

// Prefer the stable library id; camera captures only have a uri.
const assetKey = (a: ImagePicker.ImagePickerAsset) => a.assetId ?? a.uri;

function notify(title: string, message: string) {
  // Alert.alert is a no-op on web.
  if (Platform.OS === "web") window.alert(`${title}\n\n${message}`);
  else Alert.alert(title, message);
}

export function EquipmentUploadForm() {
  const [images, setImages] = useState<ImagePicker.ImagePickerAsset[]>([]);
  const [brand, setBrand] = useState("");
  const [model, setModel] = useState("");
  const upload = useEquipmentUpload();
  const network = useNetworkState();

  const offline = network.isConnected === false;
  const busy = upload.phase === "uploading";
  const doneCount = upload.statuses.filter((s) => s === "done").length;
  const canSubmit =
    images.length > 0 && brand.trim() !== "" && model.trim() !== "" && !busy;
  const canResume =
    upload.phase === "error" &&
    !(upload.error instanceof UploadError && upload.error.kind === "rejected");

  // Editing the form after an attempt clears the per-photo status. Resume
  // still works if the photos and fields end up unchanged.
  function edit<T>(setter: (v: T) => void) {
    return (v: T) => {
      upload.dismiss();
      setter(v);
    };
  }

  function addImages(assets: ImagePicker.ImagePickerAsset[]) {
    upload.dismiss();
    setImages((prev) => {
      const seen = new Set(prev.map(assetKey));
      const next = [...prev, ...assets.filter((a) => !seen.has(assetKey(a)))];
      if (next.length > MAX_IMAGES) {
        notify("Too many photos", `You can upload at most ${MAX_IMAGES} photos.`);
        return next.slice(0, MAX_IMAGES);
      }
      return next;
    });
  }

  function removeImage(key: string) {
    upload.dismiss();
    setImages((prev) => prev.filter((a) => assetKey(a) !== key));
  }

  async function pickFromLibrary() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      notify("Permission needed", "Allow photo library access to choose images.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync(LIBRARY_OPTIONS);
    if (!result.canceled) addImages(result.assets);
  }

  async function takePhoto() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      notify("Permission needed", "Allow camera access to take a photo.");
      return;
    }
    try {
      // The camera returns one photo per launch; each capture is appended.
      const result = await ImagePicker.launchCameraAsync(CAMERA_OPTIONS);
      if (!result.canceled) addImages(result.assets);
    } catch {
      // e.g. iOS Simulator has no camera.
      notify("Camera unavailable", "This device has no camera available.");
    }
  }

  async function submit() {
    const b = brand.trim();
    const m = model.trim();
    const session = await upload.start(images, b, m);
    if (!session) return; // error is shown inline
    notify(
      "Uploaded",
      `${b} ${m} was uploaded with ${images.length} photo${images.length === 1 ? "" : "s"}.`,
    );
    upload.reset();
    setImages([]);
    setBrand("");
    setModel("");
  }

  let statusText: string | null = null;
  if (busy) {
    if (offline) statusText = "You're offline. Waiting for connection…";
    else if (upload.retry) {
      const what = upload.retry.index != null ? `photo ${upload.retry.index + 1}` : "request";
      statusText = `Problem sending ${what}. Retrying in ${Math.ceil(upload.retry.delayMs / 1000)}s (attempt ${upload.retry.attempt + 1})…`;
    } else if (upload.current != null) {
      statusText = `Uploading photo ${upload.current + 1} of ${images.length}…`;
    } else statusText = "Starting upload…";
  }

  const submitLabel = canResume
    ? doneCount > 0
      ? `Resume upload (${doneCount}/${images.length} sent)`
      : "Try again"
    : "Upload";

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      {offline && (
        <View style={styles.offlineBanner} accessibilityRole="alert">
          <Ionicons name="cloud-offline-outline" size={18} color="#fff" />
          <Text style={styles.offlineText}>
            No connection. Uploads will continue when you&apos;re back online.
          </Text>
        </View>
      )}
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {images.length > 0 ? (
          <>
            <View style={styles.galleryHeader}>
              <Text style={styles.galleryTitle}>
                {images.length} photo{images.length === 1 ? "" : "s"}
              </Text>
              {!busy && (
                <Pressable
                  onPress={() => {
                    upload.dismiss();
                    setImages([]);
                  }}
                  accessibilityRole="button"
                  hitSlop={8}
                >
                  <Text style={styles.clearText}>Clear all</Text>
                </Pressable>
              )}
            </View>
            <View style={styles.grid}>
              {images.map((img, i) => {
                const key = assetKey(img);
                return (
                  <View key={key} style={styles.cell}>
                    <Image
                      source={{ uri: img.uri }}
                      style={styles.thumb}
                      resizeMode="cover"
                      accessibilityLabel={`Photo ${i + 1}`}
                    />
                    <StatusOverlay status={upload.statuses[i]} />
                    {!busy && (
                      <Pressable
                        onPress={() => removeImage(key)}
                        accessibilityRole="button"
                        accessibilityLabel={`Remove photo ${i + 1}`}
                        hitSlop={8}
                        style={styles.removeButton}
                      >
                        <Ionicons name="close" size={16} color="#fff" />
                      </Pressable>
                    )}
                  </View>
                );
              })}
            </View>
          </>
        ) : (
          <View style={styles.preview}>
            <View style={styles.previewEmpty}>
              <Ionicons name="images-outline" size={48} color={colors.textMuted} />
              <Text style={styles.muted}>No photos yet</Text>
            </View>
          </View>
        )}

        <View style={styles.row}>
          <ImageButton
            icon="images-outline"
            label="Upload"
            onPress={pickFromLibrary}
            disabled={busy}
          />
          <ImageButton
            icon="camera-outline"
            label="Camera"
            onPress={takePhoto}
            disabled={busy}
          />
        </View>

        <Text style={styles.label}>Brand</Text>
        <TextInput
          style={styles.input}
          value={brand}
          onChangeText={edit(setBrand)}
          editable={!busy}
          maxLength={100}
          placeholder="e.g. Caterpillar"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="words"
          returnKeyType="next"
        />

        <Text style={styles.label}>Model</Text>
        <TextInput
          style={styles.input}
          value={model}
          onChangeText={edit(setModel)}
          editable={!busy}
          maxLength={100}
          placeholder="e.g. 320 Excavator"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="characters"
          returnKeyType="done"
        />

        {upload.phase === "error" && (
          <View style={styles.errorBox} accessibilityRole="alert">
            <Ionicons name="alert-circle" size={20} color={DANGER} />
            <Text style={styles.errorText}>
              {describeUploadError(upload.error)}
              {doneCount > 0 && canResume
                ? ` ${doneCount} of ${images.length} photos are already on the server.`
                : ""}
            </Text>
          </View>
        )}

        <Pressable
          onPress={submit}
          disabled={!canSubmit}
          accessibilityRole="button"
          accessibilityState={{ disabled: !canSubmit, busy }}
          style={({ pressed }) => [
            styles.submit,
            !canSubmit && styles.submitDisabled,
            pressed && styles.pressed,
          ]}
        >
          {busy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <>
              <Ionicons
                name={canResume ? "refresh" : "cloud-upload-outline"}
                size={20}
                color="#fff"
              />
              <Text style={styles.submitText}>{submitLabel}</Text>
            </>
          )}
        </Pressable>

        {busy && (
          <>
            <Text style={styles.statusText} accessibilityLiveRegion="polite">
              {statusText}
            </Text>
            <Pressable
              onPress={upload.cancel}
              accessibilityRole="button"
              style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function StatusOverlay({ status }: { status?: ImageUploadStatus }) {
  if (!status) return null;
  return (
    <View
      style={[styles.overlay, status === "done" && styles.overlayClear]}
      pointerEvents="none"
    >
      {status === "uploading" && <ActivityIndicator color="#fff" />}
      {status === "pending" && <Ionicons name="time-outline" size={22} color="#fff" />}
      {status === "failed" && <Ionicons name="alert-circle" size={26} color={DANGER} />}
      {status === "done" && (
        <View style={styles.doneBadge}>
          <Ionicons name="checkmark" size={14} color="#fff" />
        </View>
      )}
    </View>
  );
}

type ImageButtonProps = {
  icon: ComponentProps<typeof Ionicons>["name"];
  label: string;
  onPress: () => void;
  disabled?: boolean;
};

function ImageButton({ icon, label, onPress, disabled }: ImageButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        styles.imageButton,
        disabled && styles.submitDisabled,
        pressed && styles.pressed,
      ]}
    >
      <Ionicons name={icon} size={28} color={colors.primary} />
      <Text style={styles.imageButtonText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: spacing.md, gap: spacing.sm },
  offlineBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.text,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  offlineText: { color: "#fff", flex: 1 },
  preview: {
    aspectRatio: 4 / 3,
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  previewEmpty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
  },
  galleryHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  galleryTitle: { fontWeight: "600", color: colors.text },
  clearText: { color: colors.primary, fontWeight: "600" },
  grid: { flexDirection: "row", flexWrap: "wrap", marginHorizontal: -4 },
  cell: { width: "33.333%", aspectRatio: 1, padding: 4 },
  thumb: { flex: 1, borderRadius: 10, backgroundColor: colors.border },
  overlay: {
    position: "absolute",
    top: 4,
    left: 4,
    right: 4,
    bottom: 4,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(15, 23, 42, 0.45)",
  },
  overlayClear: {
    backgroundColor: "transparent",
    alignItems: "flex-start",
    justifyContent: "flex-end",
    padding: 6,
  },
  doneBadge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: SUCCESS,
    alignItems: "center",
    justifyContent: "center",
  },
  removeButton: {
    position: "absolute",
    top: 8,
    right: 8,
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(15, 23, 42, 0.7)",
  },
  muted: { color: colors.textMuted },
  row: { flexDirection: "row", gap: spacing.md, marginVertical: spacing.sm },
  imageButton: {
    flex: 1,
    alignItems: "center",
    paddingVertical: spacing.md,
    gap: spacing.xs,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.surface,
  },
  imageButtonText: { color: colors.primary, fontWeight: "600" },
  label: { marginTop: spacing.sm, fontWeight: "600", color: colors.text },
  input: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    fontSize: 16,
    color: colors.text,
  },
  errorBox: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: 10,
    backgroundColor: "#FEF2F2",
    borderWidth: 1,
    borderColor: "#FECACA",
  },
  errorText: { flex: 1, color: "#991B1B" },
  submit: {
    marginTop: spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    backgroundColor: colors.primary,
    borderRadius: 12,
    paddingVertical: 14,
    minHeight: 50,
  },
  submitDisabled: { opacity: 0.4 },
  submitText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  statusText: { textAlign: "center", color: colors.textMuted },
  cancel: { alignSelf: "center", padding: spacing.sm },
  cancelText: { color: DANGER, fontWeight: "600" },
  pressed: { opacity: 0.7 },
});
