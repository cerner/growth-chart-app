require 'uri'
require 'securerandom'
require 'json'
require 'yaml'
require 'igneous/smart'

module Igneous
  module Smart
    class LaunchContextController < Igneous::Smart::ApplicationController

      include ActionView::Helpers::AssetUrlHelper

      # The Authorization server api version that is supported.
      AUTHZ_API_VERSION = '1.0'

      # This will retrieve the launch context from the db matching the launch id that is passed by the OAuth server
      # Once the context is found, they will be formatted the way the OAuth server expects
      def resolve
        @error_response = {}
        @response_context = {}

        context = LaunchContext.find_by context_id: params['launch']
        context_data = JSON.parse(context.data) unless context.blank? || context.data.blank?
        context_data['tenant'] = params['tnt'] if context_data
        username = context.username unless context.blank?

        # Remove the ' / ' from aud before its validated if it exists.
        aud = (params['aud'].to_s[-1, 1].eql?'/') ? params['aud'].to_s.chop : params['aud']

        return if invalid_request?(context, username, aud)
        context_data['username'] = username if context_data

        @response_context['params'] = context_data.except('ppr')
        @response_context['claims'] = {
          encounter: context_data['encounter'],
          patient: context_data['patient'],
          ppr: context_data['ppr'],
          user: context_data['user']
        }.reject { |_k, v| v.nil? }

        @response_context['params']['smart_style_url'] = asset_url('styles/smart-v1.json')
        @response_context['params']['need_patient_banner'] = context.need_patient_banner

        @response_context['ver'] = params['ver']
        @response_context['userfhirurl'] = user_fhir_url(context.app_id, context_data['user'].to_i.to_s, params['tnt'])

        audit_launch_context_resolve(context_data)
        render status: :ok, json: @response_context.to_json
      end

      private

      def invalid_request?(context, user, aud)
        if invalid_version? || invalid_launch_id?(context) || invalid_url?(context.app_id, aud) ||
           invalid_tenant?(context.tenant)
          audit_smart_event(:smart_launch_context_resolve, :minor_failure, tenant: params['tnt'],
                                                                           launch_context_id: params['launch'],
                                                                           error: @error_response['error'])
          render status: :bad_request, json: @error_response.to_json
          return true
        end

        if invalid_launch_context?(context)
          audit_smart_event(:smart_launch_context_resolve, :minor_failure, tenant: params['tnt'],
                                                                           error: @error_response['error'])
          render status: :internal_server_error, json: @error_response.to_json
          return true
        end

        if invalid_user?(user)
          render status: :bad_request, json: @error_response.to_json
          return true
        end

        false
      end

      def audit_launch_context_resolve(context_data)
        audit_hash = {
          tenant: params['tnt'],
          user_id: context_data['user'],
          patient_id: context_data['patient'],
          encounter_id: context_data['encounter'],
          launch_context_id: params['launch']
        }.reject { |_k, v| v.nil? }

        audit_smart_event(:smart_launch_context_resolve, :success, audit_hash)
      end

      def invalid_version?
        return false if version_components(params['ver'].to_s).first.eql?\
                       (version_components(AUTHZ_API_VERSION.to_s).first)
        @error_response['ver'] = params['ver']
        @error_response['error']  = 'urn:com:cerner:authorization:error:launch:unsupported-version'
        @error_response['id'] = SecureRandom.uuid

        log_info("error_id = #{@error_response['id']}, version '#{params['ver']}' is different "\
                           "from the supported authorization API version '#{AUTHZ_API_VERSION}'")
        true
      end

      def invalid_url?(app_id, aud)
        fhir_url = fhir_url(app_id, params['tnt'])
        return false if fhir_url.eql?(aud.to_s)
        @error_response['ver'] = params['ver']
        @error_response['error']  = 'urn:com:cerner:authorization:error:launch:unknown-resource-server'
        @error_response['id'] = SecureRandom.uuid

        log_info("error_id = #{@error_response['id']}, server '#{params['aud']}' "\
                             "is different from supported fhir server '#{fhir_url}'")
        true
      end

      def invalid_launch_id?(context)
        return false if params['launch'] && context
        @error_response['ver'] = params['ver']
        @error_response['error'] = 'urn:com:cerner:authorization:error:launch:invalid-launch-code'
        @error_response['id'] = SecureRandom.uuid

        log_info("error_id = #{@error_response['id']}, No launch param or context specified")
        true
      end

      def invalid_launch_context?(context)
        return false if context.valid?
        @error_response['ver'] = params['ver']
        @error_response['error'] = 'urn:com:cerner:authorization:error:launch:unspecified-error'
        @error_response['id'] = SecureRandom.uuid

        logger.error "#{self.class.name}, error_id = #{@error_response['id']}, #{context.errors.messages} "\
                                "thrown on retrieving context for the launch id '#{params['launch']}'"
        true
      end

      def invalid_tenant?(tenant)
        return false if tenant.to_s.eql?(params['tnt'].to_s)
        @error_response['ver'] = params['ver']
        @error_response['error'] = 'urn:com:cerner:authorization:error:launch:invalid-tenant'
        @error_response['id'] = SecureRandom.uuid

        log_info("error_id = #{@error_response['id']}, tenant '#{params['tnt']}' is "\
                                "different from the tenant '#{tenant}' in the context")
        true
      end

      def invalid_user?(user)
        return false if user.eql?(params['sub'])
        @error_response['ver'] = params['ver']
        @error_response['error'] = 'urn:com:cerner:authorization:error:launch:mismatch-identity-subject'
        @error_response['id'] = SecureRandom.uuid

        log_info("error_id = #{@error_response['id']}, subject '#{params['sub']}' is different from the"\
                          "  username '#{user}' in the context")
        true
      end

      def user_fhir_url(app_id, user_id, tenant)
        "#{fhir_url(app_id, tenant)}/Practitioner/#{user_id}"
      end

      def version_components(version)
        major, minor, patch, *other = version.split('.')
        [major, minor, patch, *other]
      end

      def fhir_url(app_id, tenant)
        if app_id.blank?
          logger.warn "#{self.class.name}, App id is nil or blank."
          return nil
        end

        app = App.find_by app_id: app_id
        if app.nil?
          logger.warn "#{self.class.name}, App is not found for app_id: #{app_id}"
          return nil
        end

        app.fhir_server.url.sub('@tenant_id@', tenant)
      end

      def log_info(info)
        ::Rails.logger.info "#{self.class.name}, #{info} for the launch id '#{params['launch']}'"
      end
    end
  end
end
