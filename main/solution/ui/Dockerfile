# Use the nginx 1.12-alpine runtime image for the production environment
FROM public.ecr.aws/nginx/nginx

# Copy the tagged files from the build to the production environmnet of the nginx server
COPY build /usr/share/nginx/html

# # Copy nginx configuration 
COPY default.conf /etc/nginx/conf.d/default.conf

 # Run the nginx server
CMD ["nginx", "-g", "daemon off;"]