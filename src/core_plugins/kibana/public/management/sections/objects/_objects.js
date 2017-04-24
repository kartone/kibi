import { saveAs } from '@spalger/filesaver';
import { filter, each, extend, find, flattenDeep, partialRight, pick, pluck, sortBy } from 'lodash';
import angular from 'angular';
import registry from 'plugins/kibana/management/saved_object_registry';
import objectIndexHTML from 'plugins/kibana/management/sections/objects/_objects.html';
import 'ui/directives/file_upload';
import uiRoutes from 'ui/routes';
import uiModules from 'ui/modules';

// kibi: imports
import RefreshKibanaIndexProvider from 'plugins/kibana/management/sections/indices/_refresh_kibana_index';
import LoadObjectsProvider from 'plugins/kibi_core/management/sections/objects/_sequential_import';
import DeleteHelperProvider from 'ui/kibi/helpers/delete_helper';
import CacheProvider from 'ui/kibi/helpers/cache_helper';
import objectActionsRegistry from 'ui/registry/object_actions';
// kibi: end

const MAX_SIZE = Math.pow(2, 31) - 1;

uiRoutes
.when('/management/siren/objects', {
  template: objectIndexHTML
});

uiModules.get('apps/management')
.directive('kbnManagementObjects', function (kbnIndex, createNotifier, Private, kbnUrl, Promise) {
  // kibi: all below dependencies added by kibi to improve import/export and delete operations
  const cache = Private(CacheProvider);
  const deleteHelper = Private(DeleteHelperProvider);
  const refreshKibanaIndex = Private(RefreshKibanaIndexProvider);
  const loadObjects = Private(LoadObjectsProvider);
  // kibi: end

  return {
    restrict: 'E',
    controllerAs: 'managementObjectsController',
    // kibi: replaces esAdmin with savedObjectsAPI
    controller: function (kbnVersion, indexPatterns, queryEngineClient, $scope, $injector, $q, AppState, savedObjectsAPI) {
      const notify = createNotifier({ location: 'Saved Objects' });

      // TODO: Migrate all scope variables to the controller.
      const $state = $scope.state = new AppState();
      $scope.currentTab = null;
      $scope.selectedItems = [];

      // kibi: object actions registry
      $scope.objectActions = Private(objectActionsRegistry).toJSON();
      // kibi: end

      this.areAllRowsChecked = function areAllRowsChecked() {
        if ($scope.currentTab.data.length === 0) {
          return false;
        }
        return $scope.selectedItems.length === $scope.currentTab.data.length;
      };

      const getData = function (filter) {
        const services = registry.all().map(function (obj) {
          const service = $injector.get(obj.service);
          return service.find(filter).then(function (data) {
            return {
              service: service,
              serviceName: obj.service,
              title: obj.title,
              type: service.type,
              data: data.hits,
              total: data.total
            };
          });
        });

        $q.all(services).then(function (data) {
          $scope.services = sortBy(data, 'title');
          let tab = $scope.services[0];
          if ($state.tab) $scope.currentTab = tab = find($scope.services, {title: $state.tab});

          $scope.$watch('state.tab', function (tab) {
            if (!tab) $scope.changeTab($scope.services[0]);
          });
        });
      };

      const refreshData = () => {
        return getData(this.advancedFilter);
      };

      // TODO: Migrate all scope methods to the controller.
      $scope.toggleAll = function () {
        if ($scope.selectedItems.length === $scope.currentTab.data.length) {
          $scope.selectedItems.length = 0;
        } else {
          $scope.selectedItems = [].concat($scope.currentTab.data);
        }
      };

      // TODO: Migrate all scope methods to the controller.
      $scope.toggleItem = function (item) {
        const i = $scope.selectedItems.indexOf(item);
        if (i >= 0) {
          $scope.selectedItems.splice(i, 1);
        } else {
          $scope.selectedItems.push(item);
        }
      };

      // TODO: Migrate all scope methods to the controller.
      $scope.open = function (item) {
        kbnUrl.change(item.url.substr(1));
      };

      // TODO: Migrate all scope methods to the controller.
      $scope.edit = function (service, item) {
        const params = {
          service: service.serviceName,
          id: item.id
        };

        kbnUrl.change('/management/siren/objects/{{ service }}/{{ id }}', params);
      };

      // TODO: Migrate all scope methods to the controller.
      $scope.bulkDelete = function () {
        // kibi: modified to do some checks before the delete
        const _delete = function () {
          return $scope.currentTab.service.delete(pluck($scope.selectedItems, 'id'))
          .then(cache.invalidate) // kibi: invalidate the cache of saved objects
          .then(refreshData)
          .then(function () {
            $scope.selectedItems.length = 0;
          })
          .catch(error => notify.error(error));
        };

        deleteHelper.deleteByType($scope.currentTab.service.type, pluck($scope.selectedItems, 'id'), _delete);
        // kibi: end
      };

      // TODO: Migrate all scope methods to the controller.
      $scope.bulkExport = function () {
        const objs = $scope.selectedItems.map(partialRight(extend, {type: $scope.currentTab.type}));
        retrieveAndExportDocs(objs);
      };

      // TODO: Migrate all scope methods to the controller.
      $scope.exportAll = () => Promise
        .map($scope.services, service => service.service
          .scanAll('')
          .then(result => result.hits.map(hit => extend(hit, { type: service.type })))
        )
        .then((results) => {
          // kibi: export extra objects
          results.push([ { id: kbnVersion, type: 'config' } ]); // kibi: here we also want to export "config" type
          return indexPatterns.getIds().then(function (list) {
            each(list, (id) => {
              results.push([ { id, type: 'index-pattern' } ]); // kibi: here we also want to export all index patterns
            });
            return retrieveAndExportDocs(flattenDeep(results));
          });
          // kibi: end
        })
        .catch(notify.error);

      function retrieveAndExportDocs(objs) {
        if (!objs.length) return notify.error('No saved objects to export.');
        // kibi: use savedObjectsAPI instead of es
        savedObjectsAPI.mget({
          body: {docs: objs.map(transformToMget)}
        })
        .then(function (response) {
          saveToFile(response.docs.map(partialRight(pick, '_id', '_type', '_source')));
        });
      }

      // Takes an object and returns the associated data needed for an mget API request
      function transformToMget(obj) {
        // kibi: added index
        return {index: kbnIndex, _id: obj.id, _type: obj.type};
      }

      function saveToFile(results) {
        const blob = new Blob([angular.toJson(results, true)], {type: 'application/json'});
        saveAs(blob, 'export.json');
      }

      // TODO: Migrate all scope methods to the controller.
      $scope.importAll = function (fileContents) {
        let docs;
        try {
          docs = JSON.parse(fileContents);
        } catch (e) {
          notify.error('The file could not be processed.');
        }

        // kibi: change the import to sequential to solve the dependency problem between objects
        // as visualisations could depend on searches
        // lets order the export to make sure that searches comes before visualisations
        // then also import object sequentially to avoid errors
        const configDocument = find(docs, '_type', 'config');
        return loadObjects($scope.services, docs, configDocument, notify)
        .then(refreshKibanaIndex)
        .then(() => queryEngineClient.clearCache()) // kibi: to clear backend cache
        .then(refreshData)
        .catch(notify.error);
      };

      // TODO: Migrate all scope methods to the controller.
      $scope.changeTab = function (tab) {
        $scope.currentTab = tab;
        $scope.selectedItems.length = 0;
        $state.tab = tab.title;
        $state.save();
      };

      $scope.$watch('managementObjectsController.advancedFilter', function (filter) {
        getData(filter);
      });
    }
  };
});