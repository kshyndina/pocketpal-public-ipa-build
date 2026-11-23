import React, {useState, useContext, useEffect} from 'react';
import {FlatList, RefreshControl, Alert, View} from 'react-native';

import {reaction, computed} from 'mobx';
import {observer} from 'mobx-react-lite';
import {Portal, Snackbar, Button} from 'react-native-paper';

import {useTheme} from '../../hooks';

import {FABGroup} from './FABGroup';
import {ModelCard} from './ModelCard';
import {createStyles} from './styles';
import {HFModelSearch} from './HFModelSearch';
import {ModelAccordion} from './ModelAccordion';
import {
  DownloadErrorDialog,
  ErrorSnackbar,
  ModelSettingsSheet,
  ModelErrorReportSheet,
  RemoteModelSheet,
  ServerDetailsSheet,
} from '../../components';

import {uiStore, modelStore, hfStore, UIStore, serverStore} from '../../store';

import {L10nContext} from '../../utils';
import {Model, ModelOrigin} from '../../utils/types';
import {importGGUF, pickGGUF} from '../../utils/importGGUF';
import {ErrorState} from '../../utils/errors';

export const ModelsScreen: React.FC = observer(() => {
  const l10n = useContext(L10nContext);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [hfSearchVisible, setHFSearchVisible] = useState(false);
  const [isCopyingModel, setIsCopyingModel] = useState(false);
  const [selectedModel, setSelectedModel] = useState<Model | undefined>();
  const [settingsVisible, setSettingsVisible] = useState(false);

  // Centralized error state tracking - derive directly from MobX stores
  const [activeError, setActiveError] = useState<ErrorState | null>(null);
  const [isShowingErrorDialog, setIsShowingErrorDialog] = useState(false);

  // Model error report sheet state
  const [isErrorReportVisible, setIsErrorReportVisible] = useState(false);
  const [errorToReport, setErrorToReport] = useState<ErrorState | null>(null);

  // Remote model / server details sheets
  const [remoteModelSheetVisible, setRemoteModelSheetVisible] = useState(false);
  const [serverDetailsSheetVisible, setServerDetailsSheetVisible] =
    useState(false);
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);

  const theme = useTheme();
  const styles = createStyles(theme);

  const filters = uiStore.pageStates.modelsScreen.filters;
  const expandedGroups = uiStore.pageStates.modelsScreen.expandedGroups;

  // Set up MobX reactions to track store changes
  useEffect(() => {
    // Create a reaction for error handling
    const errorDisposer = reaction(
      // Track these observable values
      () => ({
        hfError: hfStore.error,
        downloadError: modelStore.downloadError,
        modelLoadError: modelStore.modelLoadError,
      }),
      // React to changes
      data => {
        // First check if there's a download error that should show a dialog
        const hasDialogError =
          data.downloadError && data.downloadError.metadata?.modelId;

        setIsShowingErrorDialog(!!hasDialogError);

        // Then determine which error to show in the snackbar
        if (hasDialogError) {
          // If showing a dialog, don't show snackbar
          setActiveError(null);
        } else if (data.modelLoadError) {
          // Model load errors should show in snackbar
          setActiveError(data.modelLoadError);
        } else if (data.hfError) {
          // If we have an HF error, show it
          setActiveError(data.hfError);
        } else if (data.downloadError) {
          // For download errors without model ID, show in snackbar
          setActiveError(data.downloadError);
        } else {
          // No errors to show
          setActiveError(null);
        }
      },
    );

    // Clean up the reaction when component unmounts
    return () => {
      errorDisposer();
    };
  }, []); // Only run setup once

  const onRefresh = async () => {
    setRefreshing(true);
    await modelStore.refreshDownloadStatuses();
    setRefreshing(false);
  };

  const handleOpenSettings = (model: Model) => {
    setSelectedModel(model);
    setSettingsVisible(true);
  };

  const handleCloseSettings = () => {
    setSettingsVisible(false);
    setSelectedModel(undefined);
  };

  const handleAddRemoteModel = () => {
    setRemoteModelSheetVisible(true);
  };

  const handleManageServers = () => {
    const servers = serverStore.servers;
    if (servers.length === 1) {
      handleOpenServerDetails(servers[0].id);
    } else if (servers.length > 1) {
      Alert.alert(l10n.settings.manageServers, undefined, [
        ...servers.map(server => ({
          text: server.name,
          onPress: () => handleOpenServerDetails(server.id),
        })),
        {text: l10n.common.cancel, style: 'cancel' as const},
      ]);
    }
  };

  const handleOpenServerDetails = (serverId: string) => {
    setSelectedServerId(serverId);
    setServerDetailsSheetVisible(true);
  };

  const handleDismissError = () => {
    // Clear errors from all stores
    hfStore.clearError();
    modelStore.clearDownloadError();
    modelStore.clearModelLoadError();
  };

  const handleRetryAction = () => {
    if (activeError?.context === 'search') {
      hfStore.fetchModels();
    } else if (activeError?.context === 'download') {
      modelStore.retryDownload();
    } else if (activeError?.context === 'modelInit') {
      // Retry model initialization
      const modelId = activeError.metadata?.modelId;
      if (modelId) {
        const model = modelStore.models.find(m => m.id === modelId);
        if (model) {
          modelStore.selectModel(model);
        }
      }
    }
    handleDismissError();
  };

  const handleReportModelError = () => {
    if (activeError?.context === 'modelInit') {
      setErrorToReport(activeError);
      setIsErrorReportVisible(true);
      handleDismissError();
    }
  };

  const handleCloseErrorReport = () => {
    setIsErrorReportVisible(false);
    setErrorToReport(null);
  };

  const handleAddLocalModel = async () => {
    if (isCopyingModel) {return;}
    try {
      const file = await pickGGUF();
      if (!file) {return;}
      setIsCopyingModel(true);
      await importGGUF(file, async path => {
        try {
          await modelStore.addLocalModel(path);
        } catch (error) {
          modelStore.removeModelByFullPath(path);
          throw error;
        }
      });
    } catch (error) {
      Alert.alert(l10n.models.fileManagement.copyFailed,
        error instanceof Error ? error.message : String(error));
    } finally {
      setIsCopyingModel(false);
    }
  };

  const activeModelId = modelStore.activeModel?.id;
  const models = modelStore.displayModels;

  // useMemo uses shallow comaprison for dependencies,
  // so we use computed instead for deep comparison
  // (model state changes not-downloaded -> downloaded)
  const filteredAndSortedModels = computed(() => {
    let result = models;
    if (filters.includes('downloaded')) {
      result = result.filter(model => model.isDownloaded);
    }
    if (!filters.includes('grouped')) {
      result = result.sort((a, b) => {
        if (a.isDownloaded && !b.isDownloaded) {
          return -1;
        }
        if (!a.isDownloaded && b.isDownloaded) {
          return 1;
        }
        return 0;
      });
    }
    if (filters.includes('hf')) {
      result = result.filter(model => model.origin === ModelOrigin.HF);
    }
    return result;
  }).get();

  const getGroupDisplayName = (key: string) => {
    switch (key) {
      case UIStore.GROUP_KEYS.READY_TO_USE:
        return l10n.models.labels.availableToUse;
      case UIStore.GROUP_KEYS.AVAILABLE_TO_DOWNLOAD:
        return l10n.models.labels.availableToDownload;
      default:
        return key;
    }
  };

  const groupedModels = computed(() => {
    if (!filters.includes('grouped')) {
      return {
        [UIStore.GROUP_KEYS.READY_TO_USE]: filteredAndSortedModels.filter(
          model => model.isDownloaded,
        ),
        [UIStore.GROUP_KEYS.AVAILABLE_TO_DOWNLOAD]:
          filteredAndSortedModels.filter(model => !model.isDownloaded),
      };
    }

    return filteredAndSortedModels.reduce(
      (acc, item) => {
        const groupKey =
          item.origin === ModelOrigin.LOCAL || item.isLocal
            ? l10n.models.labels.localModel
            : item.type || l10n.models.labels.unknownGroup;

        if (!acc[groupKey]) {
          acc[groupKey] = [];
        }
        acc[groupKey].push(item);
        return acc;
      },
      {} as Record<string, Model[]>,
    );
  }).get();

  const toggleGroup = (type: string) => {
    const currentExpandedGroups =
      uiStore.pageStates.modelsScreen.expandedGroups;
    const updatedExpandedGroups = {
      ...currentExpandedGroups,
      [type]: !currentExpandedGroups[type],
    };
    uiStore.setValue('modelsScreen', 'expandedGroups', updatedExpandedGroups);
  };

  const renderGroupHeader = ({item: group}) => {
    const isExpanded = expandedGroups[group.type];
    const displayName = filters.includes('grouped')
      ? group.type
      : getGroupDisplayName(group.type);
    const description =
      !filters.includes('grouped') &&
      group.type === UIStore.GROUP_KEYS.AVAILABLE_TO_DOWNLOAD
        ? l10n.models.labels.useAddButtonForMore
        : undefined;
    return (
      <ModelAccordion
        group={{...group, type: displayName}}
        expanded={isExpanded}
        description={description}
        onPress={() => toggleGroup(group.type)}>
        <FlatList
          data={group.items}
          keyExtractor={subItem => subItem.id}
          renderItem={({item: subItem}) => (
            <ModelCard
              model={subItem}
              activeModelId={activeModelId}
              onOpenSettings={() => handleOpenSettings(subItem)}
              onOpenServerDetails={handleOpenServerDetails}
            />
          )}
        />
      </ModelAccordion>
    );
  };

  const flatListModels = Object.keys(groupedModels)
    .map(type => ({
      type,
      items: groupedModels[type],
    }))
    .filter(group => group.items.length > 0);

  return (
    <View style={styles.container} testID="models-screen">
      {/* Show Error Snackbar only if no dialog is visible */}
      {!isShowingErrorDialog && activeError && (
        <ErrorSnackbar
          error={activeError}
          onDismiss={handleDismissError}
          onRetry={handleRetryAction}
          onReport={handleReportModelError}
        />
      )}

      <Button mode="contained" icon="folder-open" testID="import-gguf-button"
        disabled={isCopyingModel} onPress={handleAddLocalModel}>
        {l10n.models.buttons.importGGUF}
      </Button>

      <FlatList
        testID="flat-list"
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.listContainer}
        data={flatListModels}
        keyExtractor={item => item.type}
        extraData={activeModelId}
        renderItem={renderGroupHeader}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={[theme.colors.primary]}
          />
        }
      />

      {/* DownloadErrorDialog with Portal for better visibility */}
      <Portal>
        <DownloadErrorDialog
          visible={isShowingErrorDialog}
          onDismiss={() => {
            modelStore.clearDownloadError();
          }}
          error={modelStore.downloadError}
          model={
            modelStore.downloadError?.metadata?.modelId
              ? modelStore.models.find(
                  m => m.id === modelStore.downloadError?.metadata?.modelId,
                )
              : undefined
          }
          onTryAgain={modelStore.retryDownload}
          onImportGGUF={() => {
            modelStore.clearDownloadError();
            handleAddLocalModel().catch(error => {
              console.warn('[ModelsScreen] GGUF import failed:', error);
            });
          }}
        />
      </Portal>

      <HFModelSearch
        visible={hfSearchVisible}
        onDismiss={() => setHFSearchVisible(false)}
      />
      <Snackbar
        testID="copy-model-snackbar"
        visible={isCopyingModel}
        onDismiss={() => {}}
        duration={86400000}>
        {l10n.models.fileManagement.copyingModel}
      </Snackbar>
      <FABGroup
        onAddHFModel={() => setHFSearchVisible(true)}
        onAddLocalModel={handleAddLocalModel}
        onAddRemoteModel={handleAddRemoteModel}
        onManageServers={handleManageServers}
        hasServers={serverStore.servers.length > 0}
      />
      <ModelSettingsSheet
        isVisible={settingsVisible}
        onClose={handleCloseSettings}
        model={selectedModel}
      />
      <ModelErrorReportSheet
        isVisible={isErrorReportVisible}
        onClose={handleCloseErrorReport}
        error={errorToReport}
      />
      <RemoteModelSheet
        isVisible={remoteModelSheetVisible}
        onDismiss={() => setRemoteModelSheetVisible(false)}
      />
      <ServerDetailsSheet
        isVisible={serverDetailsSheetVisible}
        onDismiss={() => {
          setServerDetailsSheetVisible(false);
          setSelectedServerId(null);
        }}
        serverId={selectedServerId}
      />
    </View>
  );
});
