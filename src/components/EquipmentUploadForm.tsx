import Ionicons from "@expo/vector-icons/Ionicons";
import * as ImagePicker from "expo-image-picker";
import { useNetworkState } from "expo-network";
import { useEffect, useRef, useState, type ComponentProps } from "react";
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
import { SafeAreaView } from "react-native-safe-area-context";

import { colors, spacing } from "@/constants/theme";
import { useEquipmentDraft } from "@/hooks/useEquipmentDraft";
import {
  fingerprintOf,
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

function notify(title: string, message: string) {
  // Alert.alert is a no-op on web.
  if (Platform.OS === "web") window.alert(`${title}\n\n${message}`);
  else Alert.alert(title, message);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function EquipmentUploadForm() {
  const draft = useEquipmentDraft({ maxImages: MAX_IMAGES });
  const { images, brand, model, resume } = draft;
  const upload = useEquipmentUpload({
    resume,
    onResumeChange: draft.setResume,
    onSuccess: (session) => onUploaded(session.totalImages),
  });
  const network = useNetworkState();

  const offline = network.isConnected === false;
  const busy = upload.phase === "uploading";
  const fingerprint = fingerprintOf(images, brand, model);
  // Resume info only applies while the photos and fields are unchanged.
  const activeResume = resume?.fingerprint === fingerprint ? resume : null;
  const queued = !!activeResume?.queued && !busy;
  const sentIds = new Set(activeResume?.sentIds ?? []);
  const statusOf = (i: number): ImageUploadStatus | undefined =>
    upload.statuses[i] ?? (sentIds.has(images[i].id) ? "done" : undefined);
  const sentCount = images.filter((_, i) => statusOf(i) === "done").length;

  const formValid =
    images.length > 0 && brand.trim() !== "" && model.trim() !== "";
  const canSubmit = formValid && !busy && !draft.importing && !queued;
  const rejected =
    upload.error instanceof UploadError && upload.error.kind === "rejected";
  const canResume =
    !rejected &&
    (upload.phase === "error" || (!!activeResume && sentCount > 0));

  // Tell the user once if saved photos were lost (e.g. app storage cleared).
  useEffect(() => {
    if (draft.missingOnLoad > 0) {
      notify(
        "Some photos are missing",
        `${plural(draft.missingOnLoad, "saved photo")} could no longer be found and ${draft.missingOnLoad === 1 ? "was" : "were"} removed.`,
      );
    }
  }, [draft.missingOnLoad]);

  // Offline-first: a queued submission starts by itself once we're online,
  // including right after app launch.
  const { start } = upload;
  const autoStartRef = useRef<string | null>(null);
  useEffect(() => {
    if (!queued || !formValid || network.isConnected !== true) return;
    if (autoStartRef.current === fingerprint) return; // one auto-attempt per connection
    autoStartRef.current = fingerprint;
    start(images, brand, model);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queued, formValid, network.isConnected, fingerprint]);
  useEffect(() => {
    if (network.isConnected === false) autoStartRef.current = null;
  }, [network.isConnected]);

  function onUploaded(count: number) {
    notify(
      "Uploaded",
      `${brand.trim()} ${model.trim()} was uploaded with ${plural(count, "photo")}.`,
    );
    upload.reset();
    draft.clearAll();
  }

  // Editing the form after an attempt clears the on-screen status. Resume
  // still works if the photos and fields end up unchanged.
  function edit<T>(setter: (v: T) => void) {
    return (v: T) => {
      upload.dismiss();
      setter(v);
    };
  }

  async function addImages(assets: ImagePicker.ImagePickerAsset[]) {
    upload.dismiss();
    const r = await draft.addAssets(assets);
    const problems: string[] = [];
    if (r.overLimit)
      problems.push(
        `${plural(r.overLimit, "photo")} skipped: the limit is ${MAX_IMAGES}.`,
      );
    if (r.failed)
      problems.push(
        `${plural(r.failed, "photo")} couldn't be saved. Your device may be out of storage.`,
      );
    if (problems.length)
      notify("Some photos weren't added", problems.join("\n"));
  }

  async function pickFromLibrary() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      notify(
        "Permission needed",
        "Allow photo library access to choose images.",
      );
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      ...LIBRARY_OPTIONS,
      selectionLimit: Math.max(1, MAX_IMAGES - images.length),
    });
    if (!result.canceled) await addImages(result.assets);
  }

  async function takePhoto() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      notify("Permission needed", "Allow camera access to take a photo.");
      return;
    }
    let result: ImagePicker.ImagePickerResult;
    try {
      // The camera returns one photo per launch; each capture is appended.
      result = await ImagePicker.launchCameraAsync(CAMERA_OPTIONS);
    } catch {
      // e.g. iOS Simulator has no camera.
      notify("Camera unavailable", "This device has no camera available.");
      return;
    }
    if (!result.canceled) await addImages(result.assets);
  }

  async function submit() {
    if (offline) {
      upload.queue(images, brand, model);
      return;
    }
    await upload.start(images, brand, model);
  }

  let statusText: string | null = null;
  if (busy) {
    if (offline) statusText = "You're offline. Waiting for connection…";
    else if (upload.autoRetry)
      statusText = null; // shown by <AutoRetryNotice>
    else if (upload.retry) {
      const what =
        upload.retry.index != null
          ? `photo ${upload.retry.index + 1}`
          : "request";
      statusText = `Problem sending ${what}. Retrying in ${Math.ceil(upload.retry.delayMs / 1000)}s (attempt ${upload.retry.attempt + 1})…`;
    } else if (upload.current != null) {
      statusText = `Uploading photo ${upload.current + 1} of ${images.length}…`;
    } else statusText = "Starting upload…";
  }

  const submitLabel = offline
    ? "Upload when online"
    : canResume
      ? sentCount > 0
        ? `Resume upload (${sentCount}/${images.length} sent)`
        : "Try again"
      : "Upload";

  return (
    <SafeAreaView style={styles.flex} edges={["top"]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        {offline && (
          <View style={styles.offlineBanner} accessibilityRole="alert">
            <Ionicons name="cloud-offline-outline" size={18} color="#fff" />
            <Text style={styles.offlineText}>
              You&apos;re offline. Your work is saved on this device.
            </Text>
          </View>
        )}
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          {images.length > 0 || draft.importing ? (
            <>
              <View style={styles.galleryHeader}>
                <Text style={styles.galleryTitle}>
                  {plural(images.length, "photo")}
                  {draft.importing ? " · saving…" : ""}
                </Text>
                {!busy && images.length > 0 && (
                  <Pressable
                    onPress={() => {
                      upload.dismiss();
                      draft.clearImages();
                    }}
                    accessibilityRole="button"
                    hitSlop={8}
                  >
                    <Text style={styles.clearText}>Clear all</Text>
                  </Pressable>
                )}
              </View>
              <View style={styles.grid}>
                {images.map((img, i) => (
                  <View key={img.id} style={styles.cell}>
                    <Image
                      source={{ uri: img.uri }}
                      style={styles.thumb}
                      resizeMode="cover"
                      accessibilityLabel={`Photo ${i + 1}`}
                    />
                    <StatusOverlay status={statusOf(i)} />
                    {!busy && (
                      <Pressable
                        onPress={() => {
                          upload.dismiss();
                          draft.removeImage(img.id);
                        }}
                        accessibilityRole="button"
                        accessibilityLabel={`Remove photo ${i + 1}`}
                        hitSlop={8}
                        style={styles.removeButton}
                      >
                        <Ionicons name="close" size={16} color="#fff" />
                      </Pressable>
                    )}
                  </View>
                ))}
                {draft.importing && (
                  <View style={styles.cell}>
                    <View style={[styles.thumb, styles.importing]}>
                      <ActivityIndicator color={colors.textMuted} />
                    </View>
                  </View>
                )}
              </View>
            </>
          ) : (
            <View style={styles.preview}>
              <View style={styles.previewEmpty}>
                <Ionicons
                  name="images-outline"
                  size={48}
                  color={colors.textMuted}
                />
                <Text style={styles.muted}>No photos yet</Text>
              </View>
            </View>
          )}

          <View style={styles.row}>
            <ImageButton
              icon="images-outline"
              label="Upload"
              testID="pick-library"
              onPress={pickFromLibrary}
              disabled={busy || images.length >= MAX_IMAGES}
            />
            <ImageButton
              icon="camera-outline"
              label="Camera"
              testID="take-photo"
              onPress={takePhoto}
              disabled={busy || images.length >= MAX_IMAGES}
            />
          </View>

          <Text style={styles.label}>Brand</Text>
          <TextInput
            style={styles.input}
            testID="brand-input"
            value={brand}
            onChangeText={edit(draft.setBrand)}
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
            testID="model-input"
            value={model}
            onChangeText={edit(draft.setModel)}
            editable={!busy}
            maxLength={100}
            placeholder="e.g. 320 Excavator"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="characters"
            returnKeyType="done"
          />

          {!draft.persistsImages && images.length > 0 && (
            <Text style={styles.hint}>
              In the browser, photos aren&apos;t kept after a reload. Brand and
              model are saved.
            </Text>
          )}

          {upload.phase === "error" && !queued && (
            <View style={styles.errorBox} accessibilityRole="alert">
              <Ionicons name="alert-circle" size={20} color={DANGER} />
              <Text style={styles.errorText}>
                {describeUploadError(upload.error)}
                {sentCount > 0 && canResume
                  ? ` ${sentCount} of ${images.length} photos are already on the server.`
                  : ""}
              </Text>
            </View>
          )}

          {queued ? (
            <View style={styles.queuedBox} accessibilityRole="alert">
              <Ionicons name="time-outline" size={20} color={colors.primary} />
              <Text style={styles.queuedText}>
                Saved on this device. It will upload automatically when
                you&apos;re back online.
              </Text>
            </View>
          ) : (
            <Pressable
              testID="submit-upload"
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
                    name={
                      offline
                        ? "time-outline"
                        : canResume
                          ? "refresh"
                          : "cloud-upload-outline"
                    }
                    size={20}
                    color="#fff"
                  />
                  <Text style={styles.submitText}>{submitLabel}</Text>
                </>
              )}
            </Pressable>
          )}

          {queued && (
            <Pressable
              onPress={() =>
                draft.setResume(
                  activeResume && { ...activeResume, queued: false },
                )
              }
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.cancel,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.cancelText}>
                Don&apos;t upload automatically
              </Text>
            </Pressable>
          )}

          {busy && (
            <>
              {upload.autoRetry && !offline ? (
                <AutoRetryNotice
                  retry={upload.autoRetry}
                  onRetryNow={upload.retryNow}
                />
              ) : (
                <Text
                  style={styles.statusText}
                  accessibilityLiveRegion="polite"
                >
                  {statusText}
                </Text>
              )}
              <Pressable
                onPress={upload.cancel}
                accessibilityRole="button"
                style={({ pressed }) => [
                  styles.cancel,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function AutoRetryNotice({
  retry,
  onRetryNow,
}: {
  retry: NonNullable<ReturnType<typeof useEquipmentUpload>["autoRetry"]>;
  onRetryNow: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.ceil((retry.retryAt - now) / 1000));

  return (
    <View style={styles.retryBox} accessibilityLiveRegion="polite">
      <Text style={styles.retryText}>
        {describeUploadError(retry.error).split(". ")[0]}.{"\n"}
        {secs > 0
          ? `Retrying automatically in ${secs}s (attempt ${retry.attempt} of ${retry.maxAttempts})…`
          : "Retrying…"}
      </Text>
      {secs > 0 && (
        <Pressable
          onPress={onRetryNow}
          accessibilityRole="button"
          hitSlop={8}
          style={({ pressed }) => pressed && styles.pressed}
        >
          <Text style={styles.retryNowText}>Retry now</Text>
        </Pressable>
      )}
    </View>
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
      {status === "pending" && (
        <Ionicons name="time-outline" size={22} color="#fff" />
      )}
      {status === "failed" && (
        <Ionicons name="alert-circle" size={26} color={DANGER} />
      )}
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
  testID?: string;
};

function ImageButton({
  icon,
  label,
  onPress,
  disabled,
  testID,
}: ImageButtonProps) {
  return (
    <Pressable
      testID={testID}
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
  hint: { color: colors.textMuted, fontSize: 13 },
  retryBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: 10,
    backgroundColor: "#FFFBEB",
    borderWidth: 1,
    borderColor: "#FDE68A",
  },
  retryText: { flex: 1, color: "#92400E" },
  retryNowText: { color: colors.primary, fontWeight: "700" },
  importing: { alignItems: "center", justifyContent: "center" },
  queuedBox: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.lg,
    padding: spacing.md,
    borderRadius: 10,
    backgroundColor: "#EFF6FF",
    borderWidth: 1,
    borderColor: "#BFDBFE",
  },
  queuedText: { flex: 1, color: colors.text },
  pressed: { opacity: 0.7 },
});
