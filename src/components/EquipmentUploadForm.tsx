import Ionicons from "@expo/vector-icons/Ionicons";
import * as ImagePicker from "expo-image-picker";
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
  UploadNotConfiguredError,
  uploadEquipment,
} from "@/lib/uploadEquipment";

const CAMERA_OPTIONS: ImagePicker.ImagePickerOptions = {
  mediaTypes: ["images"],
  quality: 0.8,
};

const LIBRARY_OPTIONS: ImagePicker.ImagePickerOptions = {
  ...CAMERA_OPTIONS,
  allowsMultipleSelection: true,
  selectionLimit: 0, // 0 = no limit
  orderedSelection: true,
};

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
  const [submitting, setSubmitting] = useState(false);

  const canSubmit =
    images.length > 0 &&
    brand.trim() !== "" &&
    model.trim() !== "" &&
    !submitting;

  function addImages(assets: ImagePicker.ImagePickerAsset[]) {
    setImages((prev) => {
      const seen = new Set(prev.map(assetKey));
      return [...prev, ...assets.filter((a) => !seen.has(assetKey(a)))];
    });
  }

  function removeImage(key: string) {
    setImages((prev) => prev.filter((a) => assetKey(a) !== key));
  }

  async function pickFromLibrary() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      notify(
        "Permission needed",
        "Allow photo library access to choose an image.",
      );
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
    if (images.length === 0) return;
    setSubmitting(true);
    try {
      await uploadEquipment({
        images,
        brand: brand.trim(),
        model: model.trim(),
      });
      notify(
        "Uploaded",
        `${brand.trim()} ${model.trim()} was uploaded with ${images.length} photo${images.length === 1 ? "" : "s"}.`,
      );
      setImages([]);
      setBrand("");
      setModel("");
    } catch (e) {
      const title =
        e instanceof UploadNotConfiguredError
          ? "Not configured"
          : "Upload failed";
      notify(title, e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
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
              <Pressable
                onPress={() => setImages([])}
                accessibilityRole="button"
                hitSlop={8}
              >
                <Text style={styles.clearText}>Clear all</Text>
              </Pressable>
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
                    <Pressable
                      onPress={() => removeImage(key)}
                      accessibilityRole="button"
                      accessibilityLabel={`Remove photo ${i + 1}`}
                      hitSlop={8}
                      style={styles.removeButton}
                    >
                      <Ionicons name="close" size={16} color="#fff" />
                    </Pressable>
                  </View>
                );
              })}
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
            onPress={pickFromLibrary}
          />
          <ImageButton
            icon="camera-outline"
            label="Camera"
            onPress={takePhoto}
          />
        </View>

        <Text style={styles.label}>Brand</Text>
        <TextInput
          style={styles.input}
          value={brand}
          onChangeText={setBrand}
          placeholder="e.g. Caterpillar"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="words"
          returnKeyType="next"
        />

        <Text style={styles.label}>Model</Text>
        <TextInput
          style={styles.input}
          value={model}
          onChangeText={setModel}
          placeholder="e.g. 320 Excavator"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="characters"
          returnKeyType="done"
        />

        <Pressable
          onPress={submit}
          disabled={!canSubmit}
          accessibilityRole="button"
          accessibilityState={{ disabled: !canSubmit, busy: submitting }}
          style={({ pressed }) => [
            styles.submit,
            !canSubmit && styles.submitDisabled,
            pressed && styles.pressed,
          ]}
        >
          {submitting ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <>
              <Ionicons name="cloud-upload-outline" size={20} color="#fff" />
              <Text style={styles.submitText}>Upload</Text>
            </>
          )}
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

type ImageButtonProps = {
  icon: ComponentProps<typeof Ionicons>["name"];
  label: string;
  onPress: () => void;
};

function ImageButton({ icon, label, onPress }: ImageButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.imageButton, pressed && styles.pressed]}
    >
      <Ionicons name={icon} size={24} color={colors.primary} />
      <Text style={styles.imageButtonText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: spacing.md, gap: spacing.sm },
  preview: {
    aspectRatio: 4 / 3,
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
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
  thumb: {
    flex: 1,
    borderRadius: 10,
    backgroundColor: colors.border,
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
  previewEmpty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
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
  pressed: { opacity: 0.7 },
});
