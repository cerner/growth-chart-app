# Configure sensitive parameters which will be filtered from the log file.
Rails.application.config.filter_parameters += [:authentication, :identity_token]