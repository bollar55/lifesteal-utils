package dev.candycup.lifestealutils.config;

import dev.candycup.lifestealutils.Config;
import dev.candycup.lifestealutils.FeatureFlagController;
import dev.candycup.lifestealutils.LifestealUtils;
import dev.candycup.lifestealutils.config.configurables.ConfigurableBoolean;
import dev.candycup.lifestealutils.config.configurables.ConfigurableEnum;
import dev.candycup.lifestealutils.config.configurables.ConfigurableFloat;
import dev.candycup.lifestealutils.config.configurables.ConfigurableList;
import dev.candycup.lifestealutils.config.configurables.ConfigurableMinimessage;
import dev.candycup.lifestealutils.config.configurables.ConfigurableString;
import dev.candycup.lifestealutils.config.controllers.MinimessageController;
import dev.candycup.lifestealutils.interapi.MessagingUtils;
import dev.isxander.yacl3.api.ConfigCategory;
import dev.isxander.yacl3.api.ListOption;
import dev.isxander.yacl3.api.Option;
import dev.isxander.yacl3.api.OptionDescription;
import dev.isxander.yacl3.api.OptionGroup;
import dev.isxander.yacl3.api.YetAnotherConfigLib;
import dev.isxander.yacl3.api.controller.EnumControllerBuilder;
import dev.isxander.yacl3.api.controller.FloatSliderControllerBuilder;
import dev.isxander.yacl3.api.controller.StringControllerBuilder;
import dev.isxander.yacl3.api.controller.TickBoxControllerBuilder;
import net.minecraft.network.chat.Component;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.function.Consumer;
import java.util.function.Supplier;
import java.util.stream.Collectors;

public class ConfigResolver {
   private static final Logger LOGGER = LoggerFactory.getLogger("lifestealutils/config-resolver");
   private static volatile Map<String, RemoteOverrideDecision> remoteOverridesByKey = Collections.emptyMap();

   public static YetAnotherConfigLib resolve() {
      ConfigDescriptorRegistry.registerDefaultProviders();
      return resolve(ConfigContainerRegistry.getRegisteredContainers());
   }

   public static YetAnotherConfigLib resolve(Class<?> configClass) {
      return resolve(List.of(configClass));
   }

   public static void applyRemoteOverridesAtLoad() {
      ConfigDescriptorRegistry.registerDefaultProviders();
      Map<String, ConfigurationOption> optionsByKey = collectOptionsByKey(ConfigContainerRegistry.getRegisteredContainers());
      resolveRemoteOverrides(optionsByKey, true);
   }

   private static YetAnotherConfigLib resolve(List<Class<?>> configClasses) {
      ConfigurationTree tree = new ConfigurationTree();
      Map<String, ConfigurationCategory> categoriesByName = new LinkedHashMap<>();
      Map<String, ConfigurationOption> optionsByKey = collectOptionsByKey(configClasses);

      resolveRemoteOverrides(optionsByKey, false);

      for (ConfigurationOption option : optionsByKey.values()) {
         addOption(categoriesByName, option);
      }

      tree.categories = sortedCategories(categoriesByName);
      return tree.toYACL();
   }

   private static Map<String, ConfigurationOption> collectOptionsByKey(List<Class<?>> configClasses) {
      Map<String, ConfigurationOption> optionsByKey = new LinkedHashMap<>();

      for (Class<?> configClass : configClasses) {
         for (Field field : configClass.getDeclaredFields()) {
            ConfigurationOption option = optionFromStaticField(field);
            if (option == null) {
               continue;
            }
            optionsByKey.put(option.key, option);
         }
      }

      List<ConfigOptionDescriptor<?>> dynamicOptions = new ArrayList<>();
      ConfigOptionCollector collector = dynamicOptions::add;
      for (ConfigOptionProvider provider : ConfigDescriptorRegistry.getProviders()) {
         provider.registerOptions(collector);
      }

      for (ConfigOptionDescriptor<?> descriptor : dynamicOptions) {
         ConfigurationOption option = descriptorToOption(descriptor);
         optionsByKey.put(option.key, option);
      }

      return optionsByKey;
   }

   private static void resolveRemoteOverrides(Map<String, ConfigurationOption> optionsByKey, boolean applyValues) {
      FeatureFlagController.RuntimeInfo runtimeInfo = FeatureFlagController.getRuntimeInfo();
      List<FeatureFlagController.RemoteConfigRule> rules = FeatureFlagController.getRemoteConfigRules();
      Map<String, RemoteOverrideDecision> decisions = new LinkedHashMap<>();

      for (FeatureFlagController.RemoteConfigRule rule : rules) {
         if (!rule.matches(runtimeInfo)) {
            continue;
         }

         ConfigurationOption option = optionsByKey.get(rule.applyForKey());
         if (option == null) {
            LOGGER.warn("[lsu-config] remote rule references unknown key '{}'", rule.applyForKey());
            continue;
         }

         Object coercedValue = option.coerceRemoteValue(rule.forceState());
         if (coercedValue == null) {
            LOGGER.warn(
                    "[lsu-config] remote rule rejected for key '{}' due to invalid forceState type/value",
                    rule.applyForKey()
            );
            continue;
         }

         RemoteOverrideDecision candidate = new RemoteOverrideDecision(
                 option.key,
                 coercedValue,
                 rule.reason(),
                 rule.priority(),
                 rule.order()
         );

         RemoteOverrideDecision current = decisions.get(option.key);
         if (current == null || candidate.priority > current.priority
                 || (candidate.priority == current.priority && candidate.order >= current.order)) {
            decisions.put(option.key, candidate);
         }
      }

      remoteOverridesByKey = Collections.unmodifiableMap(decisions);

      for (ConfigurationOption option : optionsByKey.values()) {
         option.remoteOverride = decisions.get(option.key);
      }

      if (applyValues) {
         Config.runWithRemoteOverrideApplication(() -> {
            for (RemoteOverrideDecision decision : decisions.values()) {
               ConfigurationOption option = optionsByKey.get(decision.key);
               if (option != null) {
                  option.applyRemoteValue(decision.forcedValue);
               }
            }
         });
      }
   }

   private static ConfigurationOption optionFromStaticField(Field field) {
      if (!Modifier.isStatic(field.getModifiers())) {
         return null;
      }

      ConfigurableBoolean configurableBoolean = field.getAnnotation(ConfigurableBoolean.class);
      ConfigurableString configurableString = field.getAnnotation(ConfigurableString.class);
      ConfigurableMinimessage configurableMinimessage = field.getAnnotation(ConfigurableMinimessage.class);
      ConfigurableFloat configurableFloat = field.getAnnotation(ConfigurableFloat.class);
      ConfigurableEnum configurableEnum = field.getAnnotation(ConfigurableEnum.class);
      ConfigurableList configurableList = field.getAnnotation(ConfigurableList.class);
      if (configurableBoolean == null && configurableString == null && configurableMinimessage == null
              && configurableFloat == null && configurableEnum == null && configurableList == null) {
         return null;
      }

      String location =
              configurableBoolean != null ? configurableBoolean.location() :
                      configurableString != null ? configurableString.location() :
                              configurableMinimessage != null ? configurableMinimessage.location() :
                                      configurableFloat != null ? configurableFloat.location() :
                                              configurableEnum != null ? configurableEnum.location() :
                                                      configurableList.location();
      OptionType optionType =
              configurableBoolean != null ? OptionType.BOOLEAN :
                      configurableString != null ? OptionType.STRING :
                              configurableMinimessage != null ? OptionType.MINIMESSAGE :
                                      configurableFloat != null ? OptionType.FLOAT :
                                              configurableEnum != null ? OptionType.ENUM :
                                                      OptionType.LIST;

      String[] segments = location.split("\\.");
      boolean isListType = optionType == OptionType.LIST;
      if (isListType && segments.length != 2) {
         throw new IllegalArgumentException("invalid list location '%s' on field '%s', expected category.group".formatted(location, field.getName()));
      }
      if (!isListType && segments.length != 3) {
         throw new IllegalArgumentException("invalid configurable location '%s' on field '%s', expected category.group.entry".formatted(location, field.getName()));
      }

      try {
         field.setAccessible(true);
         Object defaultValue = field.get(null);

         ConfigurationOption option = new ConfigurationOption();
         option.category = segments[0];
         option.group = segments[1];
         option.name = isListType ? segments[1] : segments[2];
         option.key = isListType
                 ? canonicalKey(option.category, option.group, option.group)
                 : canonicalKey(option.category, option.group, option.name);
         option.listEntry = isListType;
         option.defaultValue = optionType == OptionType.LIST
                 ? new ArrayList<>((List<String>) defaultValue)
                 : defaultValue;
         option.type = optionType;
         if (optionType == OptionType.FLOAT && configurableFloat != null) {
            option.floatMin = configurableFloat.min();
            option.floatMax = configurableFloat.max();
            option.hasFloatBounds = true;
         }
         option.enumClass = field.getType().isEnum() ? (Class<? extends Enum<?>>) field.getType() : null;
         option.valueSupplier = () -> readStaticValue(field);
         option.valueConsumer = value -> writeStaticValue(field, value);
         return option;
      } catch (IllegalAccessException e) {
         throw new IllegalStateException("failed to read configurable field '%s'".formatted(field.getName()), e);
      }
   }

   private static ConfigurationOption descriptorToOption(ConfigOptionDescriptor<?> descriptor) {
      ConfigurationOption option = new ConfigurationOption();
      option.category = descriptor.category();
      option.group = descriptor.group();
      option.name = descriptor.name();
      option.key = descriptor.kind() == ConfigOptionDescriptor.Kind.LIST
              ? canonicalKey(option.category, option.group, option.group)
              : canonicalKey(option.category, option.group, option.name);
      option.defaultValue = descriptor.kind() == ConfigOptionDescriptor.Kind.LIST
              ? new ArrayList<>((List<String>) descriptor.defaultSupplier().get())
              : descriptor.defaultSupplier().get();
      option.type = switch (descriptor.kind()) {
         case BOOLEAN -> OptionType.BOOLEAN;
         case STRING -> OptionType.STRING;
         case MINIMESSAGE -> OptionType.MINIMESSAGE;
         case FLOAT -> OptionType.FLOAT;
         case ENUM -> OptionType.ENUM;
         case LIST -> OptionType.LIST;
      };
      option.listEntry = descriptor.kind() == ConfigOptionDescriptor.Kind.LIST;
      option.enumClass = descriptor.kind() == ConfigOptionDescriptor.Kind.ENUM
              ? (Class<? extends Enum<?>>) descriptor.enumClass()
              : null;
      option.valueSupplier = descriptor.valueSupplier();
      option.valueConsumer = descriptor.valueConsumer();
      option.hardName = descriptor.hardName().orElse(null);
      option.hardDescription = descriptor.hardDescription().orElse(null);
      return option;
   }

   private static String canonicalKey(String category, String group, String name) {
      return "%s.%s.%s".formatted(category.toLowerCase(Locale.ROOT), group.toLowerCase(Locale.ROOT), name.toLowerCase(Locale.ROOT));
   }

   private static List<ConfigurationCategory> sortedCategories(Map<String, ConfigurationCategory> categoriesByName) {
      List<ConfigurationCategory> categories = new ArrayList<>(categoriesByName.values());
      categories.sort(Comparator
              .comparingInt((ConfigurationCategory configurationCategory) -> LifestealUtils.getConfigCategoryWeight(configurationCategory.name))
              .thenComparing(configurationCategory -> configurationCategory.name));
      categories.forEach(category -> category.groups.sort(Comparator
              .comparing((ConfigurationGroup configurationGroup) -> configurationGroup.name)
              .thenComparing(configurationGroup -> configurationGroup.listGroup ? configurationGroup.listOption.name : "")));
      return categories;
   }

   private static void addOption(Map<String, ConfigurationCategory> categoriesByName, ConfigurationOption option) {
      ConfigurationCategory category = categoriesByName.computeIfAbsent(option.category, name -> {
         ConfigurationCategory newCategory = new ConfigurationCategory();
         newCategory.name = name;
         newCategory.groups = new ArrayList<>();
         return newCategory;
      });

      if (option.type == OptionType.LIST) {
         ConfigurationGroup listGroup = category.groups.stream()
                 .filter(existing -> existing.listGroup && Objects.equals(existing.name, option.group))
                 .findFirst()
                 .orElseGet(() -> {
                    ConfigurationGroup newGroup = new ConfigurationGroup();
                    newGroup.category = category.name;
                    newGroup.name = option.group;
                    newGroup.listGroup = true;
                    category.groups.add(newGroup);
                    return newGroup;
                 });

         listGroup.listOption = option;
         return;
      }

      ConfigurationGroup group = category.groups.stream()
              .filter(existing -> !existing.listGroup && Objects.equals(existing.name, option.group))
              .findFirst()
              .orElseGet(() -> {
                 ConfigurationGroup newGroup = new ConfigurationGroup();
                 newGroup.category = category.name;
                 newGroup.name = option.group;
                 newGroup.optionsByName = new LinkedHashMap<>();
                 category.groups.add(newGroup);
                 return newGroup;
              });

      group.optionsByName.put(option.name, option);
   }

   private static Object readStaticValue(Field field) {
      try {
         return field.get(null);
      } catch (IllegalAccessException e) {
         throw new IllegalStateException("failed to read configurable field '%s'".formatted(field.getName()), e);
      }
   }

   private static void writeStaticValue(Field field, Object value) {
      try {
         field.set(null, value);
      } catch (IllegalAccessException e) {
         throw new IllegalStateException("failed to write configurable field '%s'".formatted(field.getName()), e);
      }
   }

   enum OptionType {
      BOOLEAN,
      STRING,
      MINIMESSAGE,
      FLOAT,
      ENUM,
      LIST,
   }

   static class ConfigurationTree {
      List<ConfigurationCategory> categories;

      public YetAnotherConfigLib toYACL() {
         List<ConfigCategory> yaclCategories = categories.stream()
                 .map(ConfigurationCategory::toYACLCategory)
                 .toList();

         return YetAnotherConfigLib.createBuilder()
                 .title(Component.translatable("lsu.config.title"))
                 .categories(yaclCategories)
                 .save(() -> Config.HANDLER.save())
                 .build();
      }
   }

   static class ConfigurationCategory {
      List<ConfigurationGroup> groups;
      String name;

      public ConfigCategory toYACLCategory() {
         return ConfigCategory.createBuilder()
                 .name(Component.translatable("lsu.config.%s".formatted(name.toLowerCase())))
                 .groups(groups.stream().map(ConfigurationGroup::toYACLGroup).collect(Collectors.toCollection(
                         ArrayList::new
                 )))
                 .build();
      }
   }

   static class ConfigurationGroup {
      Map<String, ConfigurationOption> optionsByName;
      String category;
      String name;
      boolean listGroup;
      ConfigurationOption listOption;

      public OptionGroup toYACLGroup() {
         if (listGroup) {
            return listOption.toYACLListGroup();
         }

         return OptionGroup.createBuilder()
                 .name(Component.translatable("lsu.config.%s.%s".formatted(category.toLowerCase(), name.toLowerCase())))
                 .options(optionsByName.values().stream()
                         .sorted(Comparator.comparing(configurationOption -> configurationOption.name))
                         .map(ConfigurationOption::toYACLOption).collect(Collectors.toCollection(
                                 ArrayList::new
                         )))
                 .build();
      }
   }

   static class ConfigurationOption {
      String category;
      String group;
      String name;
      String key;
      Object defaultValue;
      OptionType type;
      Class<? extends Enum<?>> enumClass;
      boolean listEntry;
      String hardName;
      String hardDescription;
      float floatMin;
      float floatMax;
      boolean hasFloatBounds;
      Supplier<?> valueSupplier;
      Consumer<?> valueConsumer;
      RemoteOverrideDecision remoteOverride;

      private Component resolveName() {
         if (hardName != null && !hardName.isBlank()) {
            return Component.literal(hardName);
         }
         return Component.translatable("lsu.config.%s.%s.%s".formatted(category.toLowerCase(), group.toLowerCase(), name.toLowerCase()));
      }

      public Option<?> toYACLOption() {
         return switch (type) {
            case BOOLEAN -> Option.<Boolean>createBuilder()
                    .name(resolveName())
                    .description(resolveDescription())
                    .available(!isRemotelyForced())
                    .binding((Boolean) defaultValue, this::readBooleanValue, this::writeBooleanValue)
                    .controller(TickBoxControllerBuilder::create)
                    .build();
            case STRING -> Option.<String>createBuilder()
                    .name(resolveName())
                    .description(resolveDescription())
                    .available(!isRemotelyForced())
                    .binding((String) defaultValue, this::readStringValue, this::writeStringValue)
                    .controller(StringControllerBuilder::create)
                    .build();
            case MINIMESSAGE -> Option.<String>createBuilder()
                    .name(resolveName())
                    .description(resolveDescription())
                    .available(!isRemotelyForced())
                    .binding((String) defaultValue, this::readStringValue, this::writeStringValue)
                    .customController(MinimessageController::new)
                    .build();
            case FLOAT -> Option.<Float>createBuilder()
                    .name(resolveName())
                    .description(resolveDescription())
                    .available(!isRemotelyForced())
                    .binding((Float) defaultValue, this::readFloatValue, this::writeFloatValue)
                    .controller(option -> FloatSliderControllerBuilder.create(option)
                            .range(floatMin, floatMax)
                            .step(0.1f))
                    .build();
            case ENUM -> createEnumOption();
            case LIST ->
                    throw new IllegalStateException("list options are represented as groups and cannot be built as plain options");
         };
      }

      private OptionDescription resolveDescription() {
         OptionDescription.Builder builder = OptionDescription.createBuilder();

         if (hardDescription != null && !hardDescription.isBlank()) {
            builder.text(Component.literal(hardDescription));
         } else if (listEntry) {
            builder.text(Component.translatable("lsu.config.%s.%s.desc".formatted(category.toLowerCase(), group.toLowerCase())));
         } else {
            builder.text(Component.translatable("lsu.config.%s.%s.%s.desc".formatted(category.toLowerCase(), group.toLowerCase(), name.toLowerCase())));
         }

         if (isRemotelyForced()) {
            builder.text(Component.literal(""));
            String reason = remoteOverride.reason;
            if (reason == null || reason.isBlank()) {
               reason = "This option is controlled by the remote registry.";
            }
            try {
               builder.text(MessagingUtils.miniMessage(reason));
            } catch (Exception ignored) {
               builder.text(Component.literal(reason));
            }
         }

         return builder.build();
      }

      private Option<?> createEnumOption() {
         Class<?> enumClassRaw = enumClass;
         if (enumClassRaw == null) {
            throw new IllegalStateException("enum option '%s' is missing enum class information".formatted(name));
         }
         if (!enumClassRaw.isEnum()) {
            throw new IllegalStateException("option '%s' is marked as enum configurable, but does not have an enum type".formatted(name));
         }

         return createEnumOptionTyped((Class<? extends Enum<?>>) enumClassRaw);
      }

      private <T extends Enum<T>> Option<?> createEnumOptionTyped(Class<? extends Enum<?>> enumClassRaw) {
         Class<T> enumClassTyped = (Class<T>) enumClassRaw;
         return Option.<T>createBuilder()
                 .name(resolveName())
                 .description(resolveDescription())
                 .available(!isRemotelyForced())
                 .binding((T) defaultValue, this::readEnumValue, this::writeEnumValue)
                 .controller(option -> EnumControllerBuilder.create(option)
                         .enumClass(enumClassTyped)
                         .formatValue(enumValue -> resolveEnumLabel(enumValue, category, group, name)))
                 .build();
      }

      private OptionGroup toYACLListGroup() {
         return ListOption.<String>createBuilder()
                 .name(Component.translatable("lsu.config.%s.%s".formatted(category.toLowerCase(), group.toLowerCase())))
                 .description(resolveDescription())
                 .available(!isRemotelyForced())
                 .binding((List<String>) defaultValue, this::readListValue, this::writeListValue)
                 .controller(StringControllerBuilder::create)
                 .initial("")
                 .build();
      }

      private boolean isRemotelyForced() {
         return remoteOverride != null;
      }

      private boolean readBooleanValue() {
         if (isRemotelyForced()) {
            return (Boolean) remoteOverride.forcedValue;
         }
         return ((Supplier<Boolean>) valueSupplier).get();
      }

      private void writeBooleanValue(boolean value) {
         if (isRemotelyForced()) {
            ((Consumer<Boolean>) valueConsumer).accept((Boolean) remoteOverride.forcedValue);
            return;
         }
         ((Consumer<Boolean>) valueConsumer).accept(value);
      }

      private String readStringValue() {
         if (isRemotelyForced()) {
            return (String) remoteOverride.forcedValue;
         }
         return ((Supplier<String>) valueSupplier).get();
      }

      private void writeStringValue(String value) {
         if (isRemotelyForced()) {
            ((Consumer<String>) valueConsumer).accept((String) remoteOverride.forcedValue);
            return;
         }
         ((Consumer<String>) valueConsumer).accept(value);
      }

      private float readFloatValue() {
         if (isRemotelyForced()) {
            return (Float) remoteOverride.forcedValue;
         }
         return ((Supplier<Float>) valueSupplier).get();
      }

      private void writeFloatValue(float value) {
         if (isRemotelyForced()) {
            ((Consumer<Float>) valueConsumer).accept((Float) remoteOverride.forcedValue);
            return;
         }
         ((Consumer<Float>) valueConsumer).accept(value);
      }

      private <T extends Enum<T>> T readEnumValue() {
         if (isRemotelyForced()) {
            return (T) remoteOverride.forcedValue;
         }
         return (T) valueSupplier.get();
      }

      private <T extends Enum<T>> void writeEnumValue(T value) {
         if (isRemotelyForced()) {
            ((Consumer<T>) valueConsumer).accept((T) remoteOverride.forcedValue);
            return;
         }
         ((Consumer<T>) valueConsumer).accept(value);
      }

      private List<String> readListValue() {
         if (isRemotelyForced()) {
            return new ArrayList<>((List<String>) remoteOverride.forcedValue);
         }
         return new ArrayList<>((List<String>) valueSupplier.get());
      }

      private void writeListValue(List<String> value) {
         if (isRemotelyForced()) {
            ((Consumer<List<String>>) valueConsumer).accept(new ArrayList<>((List<String>) remoteOverride.forcedValue));
            return;
         }
         ((Consumer<List<String>>) valueConsumer).accept(value);
      }

      private Object coerceRemoteValue(Object rawValue) {
         if (rawValue == null) {
            return null;
         }

         return switch (type) {
            case BOOLEAN -> rawValue instanceof Boolean b ? b : null;
            case STRING, MINIMESSAGE -> rawValue instanceof String s ? s : null;
            case FLOAT -> coerceFloat(rawValue);
            case ENUM -> coerceEnum(rawValue);
            case LIST -> coerceStringList(rawValue);
         };
      }

      private Float coerceFloat(Object rawValue) {
         Float value = null;
         if (rawValue instanceof Number number) {
            value = number.floatValue();
         } else if (rawValue instanceof String stringValue) {
            try {
               value = Float.parseFloat(stringValue);
            } catch (NumberFormatException ignored) {
               return null;
            }
         }

         if (value == null) {
            return null;
         }

         if (hasFloatBounds) {
            value = Math.max(floatMin, Math.min(floatMax, value));
         }
         return value;
      }

      private Object coerceEnum(Object rawValue) {
         if (!(rawValue instanceof String enumName) || enumClass == null) {
            return null;
         }
         Object[] constants = enumClass.getEnumConstants();
         if (constants == null) {
            return null;
         }
         for (Object constant : constants) {
            Enum<?> enumValue = (Enum<?>) constant;
            if (enumValue.name().equalsIgnoreCase(enumName)) {
               return enumValue;
            }
         }
         return null;
      }

      private List<String> coerceStringList(Object rawValue) {
         if (!(rawValue instanceof List<?> list)) {
            return null;
         }
         List<String> values = new ArrayList<>();
         for (Object item : list) {
            if (!(item instanceof String stringItem)) {
               return null;
            }
            values.add(stringItem);
         }
         return values;
      }

      private void applyRemoteValue(Object coercedValue) {
         switch (type) {
            case BOOLEAN -> ((Consumer<Boolean>) valueConsumer).accept((Boolean) coercedValue);
            case STRING, MINIMESSAGE -> ((Consumer<String>) valueConsumer).accept((String) coercedValue);
            case FLOAT -> ((Consumer<Float>) valueConsumer).accept((Float) coercedValue);
            case ENUM -> ((Consumer<Enum<?>>) valueConsumer).accept((Enum<?>) coercedValue);
            case LIST -> ((Consumer<List<String>>) valueConsumer).accept(new ArrayList<>((List<String>) coercedValue));
         }
      }

      private Component resolveEnumLabel(Enum<?> enumValue, String category, String group, String name) {
         try {
            Method getTranslationKey = enumValue.getClass().getMethod("getTranslationKey");
            if (getTranslationKey.getReturnType() == String.class) {
               String translationKey = (String) getTranslationKey.invoke(enumValue);
               if (translationKey != null && !translationKey.isBlank()) {
                  return Component.translatable(translationKey);
               }
            }
         } catch (Exception ignored) {
         }

         String valueKey = "lsu.config.%s.%s.%s.%s"
                 .formatted(category.toLowerCase(), group.toLowerCase(), name.toLowerCase(), enumValue.name().toLowerCase());
         return Component.translatable(valueKey);
      }
   }

   private static final class RemoteOverrideDecision {
      private final String key;
      private final Object forcedValue;
      private final String reason;
      private final int priority;
      private final int order;

      private RemoteOverrideDecision(String key, Object forcedValue, String reason, int priority, int order) {
         this.key = key;
         this.forcedValue = forcedValue;
         this.reason = reason;
         this.priority = priority;
         this.order = order;
      }
   }
}
